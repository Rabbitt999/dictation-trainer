(() => {
    const STORAGE_KEY = "dictation_trainer_raw_words_v1";
    const LANG_STORAGE_KEY = "dictation_trainer_lang_v1";
    const MAX_HISTORY_ITEMS = 3;
    const MAX_INPUT_CHARS = 200000;
    const SAMPLE_WORDS = [
        "kitchen - Кухня",
        "window - Вікно",
        "book - Книга",
        "morning - Ранок",
        "apple - Яблуко",
        "water - Вода",
        "house - Будинок",
        "friend - Друг"
    ].join("\n");

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const langEnBtn = document.getElementById("langEnBtn");
    const langUkBtn = document.getElementById("langUkBtn");
    const listenToggle = document.getElementById("listenToggle");
    const openEditorBtn = document.getElementById("openEditorBtn");
    const historyList = document.getElementById("historyList");
    const currentWordBox = document.getElementById("currentWordBox");
    const translationText = document.getElementById("translationText");
    const originalText = document.getElementById("originalText");

    const editorModal = document.getElementById("editorModal");
    const wordListInput = document.getElementById("wordListInput");
    const parsedCount = document.getElementById("parsedCount");
    const pasteBtn = document.getElementById("pasteBtn");
    const cancelEditorBtn = document.getElementById("cancelEditorBtn");
    const saveWordsBtn = document.getElementById("saveWordsBtn");

    let activeLang = localStorage.getItem(LANG_STORAGE_KEY) === "uk-UA" ? "uk-UA" : "en-US";
    let recognition = null;
    let restartTimer = null;
    let isListening = false;
    let wakeLock = null;
    let currentDisplay = null;
    let historyItems = [];
    let currentIndex = null;

    function setStatus(state, message) {
        statusDot.className = `status-dot status-${state}`;
        statusText.textContent = message;
    }

    function updateLangButtons() {
        langEnBtn.classList.toggle("active", activeLang === "en-US");
        langUkBtn.classList.toggle("active", activeLang === "uk-UA");
    }

    function cleanDisplay(text) {
        return text.trim().replace(/\s+/g, " ");
    }

    function normalizeForMatch(text) {
        return text
            .toLowerCase()
            .replace(/['’`]/g, "")
            .replace(/ґ/g, "г")
            .replace(/[.,!?;:"()\[\]—–-]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    // Safe O(n) parser without backtracking regexes
    function parseWordList(rawText) {
        const safeText = rawText.slice(0, MAX_INPUT_CHARS);
        const pairs = [];
        const lines = safeText.split(/\r?\n/);

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            let splitIdx = line.search(/\s+[—–-]\s+/);
            let left = "";
            let right = "";

            if (splitIdx !== -1) {
                left = line.slice(0, splitIdx);
                const rest = line.slice(splitIdx).replace(/^\s+[—–-]\s+/, "");
                right = rest;
            } else {
                const dashIdx = line.search(/[—–-]/);
                if (dashIdx <= 0) continue;
                left = line.slice(0, dashIdx);
                right = line.slice(dashIdx + 1);
            }

            left = cleanDisplay(left);
            right = cleanDisplay(right);
            if (!left || !right) continue;

            const leftIsCyrillic = /[\u0400-\u04FF]/.test(left);
            const rightIsLatin = /[a-zA-Z]/.test(right);

            if (leftIsCyrillic && rightIsLatin) {
                pairs.push({ english: right, ukrainian: left });
            } else {
                pairs.push({ english: left, ukrainian: right });
            }
        }
        return pairs;
    }

    // Levenshtein distance with early exit
    function levenshtein(a, b) {
        if (a === b) return 0;
        const m = a.length;
        const n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;

        const dp = new Array(n + 1);
        for (let j = 0; j <= n; j++) dp[j] = j;

        for (let i = 1; i <= m; i++) {
            let prev = dp[0];
            dp[0] = i;
            for (let j = 1; j <= n; j++) {
                const temp = dp[j];
                if (a[i - 1] === b[j - 1]) {
                    dp[j] = prev;
                } else {
                    dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
                }
                prev = temp;
            }
        }
        return dp[n];
    }

    // Handles Ukrainian case endings (відмінки) & consonant alternations (г/з, к/ц, х/с)
    function normalizeUkStem(word) {
        return word
            .replace(/ці$/, "к")
            .replace(/зі$/, "г")
            .replace(/сі$/, "х");
    }

    function wordsMatch(spokenWord, dictWord, isUkrainian) {
        if (spokenWord === dictWord) return 2; // Exact match (highest priority)
        if (dictWord.length < 4 || spokenWord.length < 4) return 0;
        if (Math.abs(spokenWord.length - dictWord.length) > 2) return 0;

        if (!isUkrainian) {
            const maxDist = dictWord.length <= 5 ? 1 : 2;
            return levenshtein(spokenWord, dictWord) <= maxDist ? 1 : 0;
        }

        // Ukrainian inflection / case & indistinct-speech matching
        const sNorm = normalizeUkStem(spokenWord);
        const dNorm = normalizeUkStem(dictWord);
        if (sNorm === dNorm) return 2;

        const minLen = Math.min(sNorm.length, dNorm.length);
        const maxDist = minLen <= 5 ? 1 : 2;
        return levenshtein(sNorm, dNorm) <= maxDist ? 1 : 0;
    }

    function buildLookupIndex(pairs) {
        const enEntries = [];
        const ukEntries = [];

        for (const pair of pairs) {
            const enNorm = normalizeForMatch(pair.english);
            const ukNorm = normalizeForMatch(pair.ukrainian);
            if (enNorm) {
                enEntries.push({
                    norm: enNorm,
                    tokens: enNorm.split(" "),
                    pair
                });
            }
            if (ukNorm) {
                ukEntries.push({
                    norm: ukNorm,
                    tokens: ukNorm.split(" "),
                    pair
                });
            }
        }

        // Search transcript in context (handles multi-word phrases & single words, picks rightmost & exactest match)
        function findBestMatchInContext(transcript, entries, isUkrainian) {
            const cleaned = normalizeForMatch(transcript);
            if (!cleaned) return null;

            const spokenTokens = cleaned.split(" ");
            let bestEndIdx = -1;
            let bestScore = 0;
            let bestLength = 0;
            let bestPair = null;

            for (const entry of entries) {
                const phraseLen = entry.tokens.length;
                if (phraseLen > spokenTokens.length) continue;

                for (let start = 0; start <= spokenTokens.length - phraseLen; start++) {
                    let minWordScore = 2;
                    let allMatched = true;
                    for (let offset = 0; offset < phraseLen; offset++) {
                        const score = wordsMatch(spokenTokens[start + offset], entry.tokens[offset], isUkrainian);
                        if (score === 0) {
                            allMatched = false;
                            break;
                        }
                        if (score < minWordScore) minWordScore = score;
                    }

                    if (allMatched) {
                        const endIdx = start + phraseLen - 1;
                        const isBetter =
                            endIdx > bestEndIdx ||
                            (endIdx === bestEndIdx && minWordScore > bestScore) ||
                            (endIdx === bestEndIdx && minWordScore === bestScore && phraseLen > bestLength);
                        if (isBetter) {
                            bestEndIdx = endIdx;
                            bestScore = minWordScore;
                            bestLength = phraseLen;
                            bestPair = entry.pair;
                        }
                    }
                }
            }

            return bestPair;
        }

        return {
            matchByActiveLang(transcript, lang) {
                if (lang === "uk-UA") {
                    const pair = findBestMatchInContext(transcript, ukEntries, true);
                    return pair ? { translation: pair.english, spokenOriginal: pair.ukrainian } : null;
                }
                const pair = findBestMatchInContext(transcript, enEntries, false);
                return pair ? { translation: pair.ukrainian, spokenOriginal: pair.english } : null;
            }
        };
    }

    function getRawWords() {
        return localStorage.getItem(STORAGE_KEY) ?? SAMPLE_WORDS;
    }

    function saveRawWords(rawText) {
        const safeText = rawText.slice(0, MAX_INPUT_CHARS);
        try {
            localStorage.setItem(STORAGE_KEY, safeText);
        } catch (err) {
            alert("Не вдалося зберегти: занадто великий список.");
        }
        return parseWordList(safeText);
    }

    function refreshIdleSubtitle() {
        if (!currentDisplay) {
            const count = parseWordList(getRawWords()).length;
            translationText.textContent = "Очікування слова…";
            originalText.textContent = `(${count} слів у словнику)`;
        }
    }

    function renderHistory() {
        // Strictly use textContent (no innerHTML) to prevent XSS
        historyList.replaceChildren();
        const total = historyItems.length;
        historyItems.forEach((item, idx) => {
            const age = total - idx; // 1 = most recent previous, 2 = older, 3 = oldest
            const row = document.createElement("div");
            row.className = "history-item";
            row.dataset.age = String(age);

            const tr = document.createElement("div");
            tr.className = "history-translation";
            tr.textContent = item.translation;

            const orig = document.createElement("div");
            orig.className = "history-original";
            orig.textContent = `(${item.spokenOriginal})`;

            row.appendChild(tr);
            row.appendChild(orig);
            historyList.appendChild(row);
        });
    }

    function displayRecognizedWord(display) {
        if (
            currentDisplay &&
            currentDisplay.translation === display.translation &&
            currentDisplay.spokenOriginal === display.spokenOriginal
        ) {
            return;
        }

        if (currentDisplay) {
            historyItems.push(currentDisplay);
            if (historyItems.length > MAX_HISTORY_ITEMS) {
                historyItems.shift();
            }
            renderHistory();
        }

        currentDisplay = display;
        translationText.textContent = display.translation;
        originalText.textContent = `(${display.spokenOriginal})`;

        currentWordBox.classList.remove("word-enter");
        void currentWordBox.offsetWidth;
        currentWordBox.classList.add("word-enter");
    }

    async function requestWakeLock() {
        if (!("wakeLock" in navigator)) return;
        try {
            wakeLock = await navigator.wakeLock.request("screen");
        } catch (_) {}
    }

    async function releaseWakeLock() {
        if (wakeLock) {
            try { await wakeLock.release(); } catch (_) {}
            wakeLock = null;
        }
    }

    function cleanupRecognitionInstance() {
        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }
        if (recognition) {
            const old = recognition;
            recognition = null;
            old.onstart = null;
            old.onresult = null;
            old.onerror = null;
            old.onend = null;
            try { old.stop(); } catch (_) {}
        }
    }

    // Creates a fresh SpeechRecognition instance each time (critical for iOS Safari auto-restart)
    function spawnRecognition() {
        if (!isListening || !SpeechRecognition) return;

        cleanupRecognitionInstance();

        const rec = new SpeechRecognition();
        rec.lang = activeLang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 10;

        rec.onstart = () => {
            if (isListening) {
                setStatus("listening", `Слухає (${activeLang === "en-US" ? "EN" : "UK"})`);
            }
        };

        rec.onresult = (event) => {
            if (!currentIndex) return;
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const res = event.results[i];
                for (let alt = 0; alt < res.length; alt++) {
                    const transcript = res[alt]?.transcript;
                    if (!transcript) continue;
                    const matched = currentIndex.matchByActiveLang(transcript, activeLang);
                    if (matched) {
                        displayRecognizedWord(matched);
                        return;
                    }
                }
            }
        };

        rec.onerror = (event) => {
            if (event.error === "not-allowed" || event.error === "service-not-allowed") {
                isListening = false;
                listenToggle.checked = false;
                cleanupRecognitionInstance();
                releaseWakeLock();
                setStatus("error", "Доступ до мікрофона заборонено");
            }
            // For "no-speech", "aborted", "network" on iOS/Android, onend handles clean restart
        };

        rec.onend = () => {
            if (!isListening) return;
            restartTimer = setTimeout(() => {
                if (isListening) {
                    spawnRecognition();
                }
            }, 180);
        };

        recognition = rec;
        try {
            rec.start();
        } catch (_) {
            restartTimer = setTimeout(() => {
                if (isListening) spawnRecognition();
            }, 300);
        }
    }

    function startListening() {
        if (!SpeechRecognition) {
            listenToggle.checked = false;
            setStatus("error", "Браузер не підтримує розпізнавання мовлення");
            return;
        }

        const pairs = parseWordList(getRawWords());
        if (pairs.length === 0) {
            listenToggle.checked = false;
            alert("Список слів порожній. Додайте хоча б одну пару слів.");
            return;
        }

        currentIndex = buildLookupIndex(pairs);
        isListening = true;
        requestWakeLock();
        spawnRecognition();
    }

    function stopListening() {
        isListening = false;
        cleanupRecognitionInstance();
        releaseWakeLock();
        setStatus("paused", "Пауза");
    }

    function switchLanguage(newLang) {
        if (activeLang === newLang) return;
        activeLang = newLang;
        localStorage.setItem(LANG_STORAGE_KEY, activeLang);
        updateLangButtons();
        if (isListening) {
            cleanupRecognitionInstance();
            restartTimer = setTimeout(() => {
                if (isListening) spawnRecognition();
            }, 250);
        }
    }

    langEnBtn.addEventListener("click", () => switchLanguage("en-US"));
    langUkBtn.addEventListener("click", () => switchLanguage("uk-UA"));

    listenToggle.addEventListener("change", () => {
        if (listenToggle.checked) {
            startListening();
        } else {
            stopListening();
        }
    });

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && isListening) {
            requestWakeLock();
            if (!recognition) spawnRecognition();
        }
    });

    // Editor modal handlers
    function updateParsedCount(text) {
        const count = parseWordList(text).length;
        parsedCount.textContent = `Розпізнано пар: ${count}`;
    }

    openEditorBtn.addEventListener("click", () => {
        const raw = getRawWords();
        wordListInput.value = raw;
        updateParsedCount(raw);
        editorModal.classList.remove("hidden");
    });

    wordListInput.addEventListener("input", () => {
        updateParsedCount(wordListInput.value);
    });

    pasteBtn.addEventListener("click", async () => {
        try {
            const clipText = await navigator.clipboard.readText();
            if (!clipText) {
                alert("Буфер обміну порожній");
                return;
            }
            wordListInput.value = clipText.slice(0, MAX_INPUT_CHARS);
            updateParsedCount(wordListInput.value);
        } catch (_) {
            alert("Надайте дозвіл на читання буфера обміну або вставте текст вручну.");
        }
    });

    cancelEditorBtn.addEventListener("click", () => {
        editorModal.classList.add("hidden");
    });

    saveWordsBtn.addEventListener("click", () => {
        const updatedPairs = saveRawWords(wordListInput.value);
        editorModal.classList.add("hidden");
        if (isListening) {
            if (updatedPairs.length === 0) {
                listenToggle.checked = false;
                stopListening();
                refreshIdleSubtitle();
                return;
            }
            // Update lookup index live without interrupting the active microphone
            currentIndex = buildLookupIndex(updatedPairs);
            if (!recognition) {
                spawnRecognition();
            }
        } else {
            refreshIdleSubtitle();
        }
    });

    updateLangButtons();
    refreshIdleSubtitle();
    if (!SpeechRecognition) {
        listenToggle.disabled = true;
        setStatus("error", "Web Speech API недоступний у цьому браузері");
    }
})();
