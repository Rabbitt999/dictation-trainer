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

    function ukPhoneticKey(word) {
        return normalizeUkStem(word)
            .replace(/(.)\1+/g, "$1")
            .replace(/[иіїй]/g, "і")
            .replace(/[еє]/g, "е")
            .replace(/ґ/g, "г")
            .replace(/щ/g, "ш")
            .replace(/дз/g, "з")
            .replace(/дж/g, "ж")
            .replace(/п/g, "б")
            .replace(/т/g, "д")
            .replace(/ф/g, "в")
            .replace(/с/g, "з")
            .replace(/ш/g, "ж")
            .replace(/к/g, "г");
    }

    function enPhoneticKey(word) {
        let res = word
            .replace(/(.)\1+/g, "$1")
            .replace(/ph/g, "f")
            .replace(/ck/g, "k")
            .replace(/qu/g, "k")
            .replace(/c(?=[eiy])/g, "s")
            .replace(/c/g, "k")
            .replace(/kn/g, "n")
            .replace(/wr/g, "r")
            .replace(/wh/g, "w")
            .replace(/w/g, "v")
            .replace(/gh/g, "")
            .replace(/ee|ea|ie/g, "i")
            .replace(/oo|ou/g, "u")
            .replace(/ae|ai|ay/g, "e");
        if (res.length > 3 && res.endsWith("e")) {
            res = res.slice(0, -1);
        }
        return res;
    }

    function wordsMatch(spokenWord, dictWord, isUkrainian) {
        if (spokenWord === dictWord) return 3; // Exact match (highest priority)
        if (dictWord.length < 3 || spokenWord.length < 3) return 0;

        if (isUkrainian) {
            const sNorm = normalizeUkStem(spokenWord);
            const dNorm = normalizeUkStem(dictWord);
            if (sNorm === dNorm) return 2;

            if (dictWord.length >= 4 && spokenWord.length >= 4) {
                const sPhon = ukPhoneticKey(spokenWord);
                const dPhon = ukPhoneticKey(dictWord);
                if (sPhon === dPhon) return 2;

                if (Math.abs(sNorm.length - dNorm.length) <= 2) {
                    const maxDist = Math.min(sNorm.length, dNorm.length) <= 5 ? 1 : 2;
                    if (levenshtein(sNorm, dNorm) <= maxDist) return 1;
                    if (Math.min(sPhon.length, dPhon.length) >= 5 && levenshtein(sPhon, dPhon) <= 1) return 1;
                }
            }
            return 0;
        }

        // English: phonetic + fuzzy matching for words >= 4 chars
        if (dictWord.length >= 4 && spokenWord.length >= 4) {
            if (enPhoneticKey(spokenWord) === enPhoneticKey(dictWord)) return 2;
            if (Math.abs(spokenWord.length - dictWord.length) <= 2) {
                const maxDist = dictWord.length <= 5 ? 1 : 2;
                if (levenshtein(spokenWord, dictWord) <= maxDist) return 1;
            }
        }
        return 0;
    }

    function splitVariants(text) {
        return text
            .split(/[,/]/)
            .map(v => normalizeForMatch(v))
            .filter(Boolean);
    }

    function buildLookupIndex(pairs) {
        const enEntries = [];
        const ukEntries = [];

        for (const pair of pairs) {
            for (const enNorm of splitVariants(pair.english)) {
                enEntries.push({
                    joined: enNorm.replace(/\s+/g, ""),
                    tokens: enNorm.split(" "),
                    pair
                });
            }
            for (const ukNorm of splitVariants(pair.ukrainian)) {
                ukEntries.push({
                    joined: ukNorm.replace(/\s+/g, ""),
                    tokens: ukNorm.split(" "),
                    pair
                });
            }
        }

        // Search transcript in context (handles multi-word phrases, split/joined words, & picks rightmost/exactest match)
        function findBestMatchInContext(transcript, entries, isUkrainian) {
            const cleaned = normalizeForMatch(transcript);
            if (!cleaned) return null;

            const spokenTokens = cleaned.split(" ");
            let bestEndIdx = -1;
            let bestScore = 0;
            let bestLength = 0;
            let bestPair = null;

            const considerCandidate = (endIdx, score, length, pair) => {
                const isBetter =
                    endIdx > bestEndIdx ||
                    (endIdx === bestEndIdx && score > bestScore) ||
                    (endIdx === bestEndIdx && score === bestScore && length > bestLength);
                if (isBetter) {
                    bestEndIdx = endIdx;
                    bestScore = score;
                    bestLength = length;
                    bestPair = pair;
                }
            };

            for (const entry of entries) {
                const phraseLen = entry.tokens.length;

                // 1. Standard token sequence match
                if (phraseLen <= spokenTokens.length) {
                    for (let start = 0; start <= spokenTokens.length - phraseLen; start++) {
                        let minWordScore = 3;
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
                            considerCandidate(start + phraseLen - 1, minWordScore, phraseLen, entry.pair);
                        }
                    }
                }

                // 2. Split compound word match: dict "sunlight" vs spoken "sun light"
                if (phraseLen === 1 && spokenTokens.length >= 2) {
                    for (let start = 0; start < spokenTokens.length - 1; start++) {
                        const merged = spokenTokens[start] + spokenTokens[start + 1];
                        const score = wordsMatch(merged, entry.joined, isUkrainian);
                        if (score > 0) {
                            considerCandidate(start + 1, score, 2, entry.pair);
                        }
                    }
                }

                // 3. Joined compound word match: dict "ice cream" vs spoken "icecream"
                if (phraseLen === 2) {
                    for (let i = 0; i < spokenTokens.length; i++) {
                        const score = wordsMatch(spokenTokens[i], entry.joined, isUkrainian);
                        if (score > 0) {
                            considerCandidate(i, score, 1, entry.pair);
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
            }, 60);
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
