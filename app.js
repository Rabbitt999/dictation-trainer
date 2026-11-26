(() => {
    const STORAGE_KEY = "dictation_trainer_raw_words_v1";
    const LANG_STORAGE_KEY = "dictation_trainer_lang_v1";
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
    let isListening = false;
    let wakeLock = null;
    let lastDisplayKey = "";
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
            .replace(/[.,!?;:"'()\[\]]/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function parseWordList(rawText) {
        const pairs = [];
        const lines = rawText.split(/\r?\n/);

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            let parts;
            if (/\s+[—–-]\s+/.test(line)) {
                const match = line.match(/^([\s\S]+?)\s+[—–-]\s+([\s\S]+)$/);
                parts = match ? [match[1], match[2]] : [];
            } else {
                const idx = line.search(/[—–-]/);
                parts = idx > 0 ? [line.slice(0, idx), line.slice(idx + 1)] : [];
            }

            if (parts.length < 2) continue;
            const left = cleanDisplay(parts[0]);
            const right = cleanDisplay(parts[1]);
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

    function buildLookupIndex(pairs) {
        const enMap = new Map();
        const ukMap = new Map();

        for (const pair of pairs) {
            const enKey = normalizeForMatch(pair.english);
            const ukKey = normalizeForMatch(pair.ukrainian);
            if (enKey && !enMap.has(enKey)) enMap.set(enKey, pair);
            if (ukKey && !ukMap.has(ukKey)) ukMap.set(ukKey, pair);
        }

        function findInMap(rawRecognized, map) {
            const cleaned = normalizeForMatch(rawRecognized);
            if (!cleaned) return null;
            if (map.has(cleaned)) return map.get(cleaned);

            const tokens = cleaned.split(" ");
            for (let i = tokens.length - 1; i >= 0; i--) {
                if (map.has(tokens[i])) return map.get(tokens[i]);
            }
            return null;
        }

        return {
            matchByActiveLang(transcript, lang) {
                if (lang === "uk-UA") {
                    const pair = findInMap(transcript, ukMap);
                    return pair ? { translation: pair.english, spokenOriginal: pair.ukrainian } : null;
                }
                const pair = findInMap(transcript, enMap);
                return pair ? { translation: pair.ukrainian, spokenOriginal: pair.english } : null;
            }
        };
    }

    function getRawWords() {
        return localStorage.getItem(STORAGE_KEY) ?? SAMPLE_WORDS;
    }

    function saveRawWords(rawText) {
        localStorage.setItem(STORAGE_KEY, rawText);
        return parseWordList(rawText);
    }

    function refreshIdleSubtitle() {
        if (!originalText.textContent || translationText.textContent === "Очікування слова…") {
            const count = parseWordList(getRawWords()).length;
            translationText.textContent = "Очікування слова…";
            originalText.textContent = `(${count} слів у словнику)`;
        }
    }

    function displayRecognizedWord(display) {
        const key = `${display.translation}|${display.spokenOriginal}`;
        if (key === lastDisplayKey) return;
        lastDisplayKey = key;
        translationText.textContent = display.translation;
        originalText.textContent = `(${display.spokenOriginal})`;
    }

    async function requestWakeLock() {
        if (!("wakeLock" in navigator)) return;
        try {
            wakeLock = await navigator.wakeLock.request("screen");
        } catch (err) {
            console.warn("WakeLock unavailable:", err);
        }
    }

    async function releaseWakeLock() {
        if (wakeLock) {
            try { await wakeLock.release(); } catch (_) {}
            wakeLock = null;
        }
    }

    function startListening() {
        if (!SpeechRecognition) {
            listenToggle.checked = false;
            setStatus("error", "Браузер не підтримує Web Speech API (використайте Chrome)");
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

        const rec = new SpeechRecognition();
        rec.lang = activeLang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 5;

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
                releaseWakeLock();
                setStatus("error", "Доступ до мікрофона заборонено");
            } else if (event.error !== "no-speech" && event.error !== "aborted") {
                console.warn("SpeechRecognition error:", event.error);
            }
        };

        rec.onend = () => {
            if (isListening) {
                // Auto-restart continuous listening seamlessly
                try {
                    rec.start();
                } catch (_) {
                    setTimeout(() => {
                        if (isListening) {
                            try { rec.start(); } catch (_) {}
                        }
                    }, 200);
                }
            }
        };

        recognition = rec;
        try {
            rec.start();
            requestWakeLock();
        } catch (err) {
            isListening = false;
            listenToggle.checked = false;
            setStatus("error", err.message || "Не вдалося запустити мікрофон");
        }
    }

    function stopListening() {
        isListening = false;
        if (recognition) {
            const rec = recognition;
            recognition = null;
            rec.onend = null;
            try { rec.stop(); } catch (_) {}
        }
        releaseWakeLock();
        setStatus("paused", "Пауза");
    }

    function switchLanguage(newLang) {
        if (activeLang === newLang) return;
        activeLang = newLang;
        localStorage.setItem(LANG_STORAGE_KEY, activeLang);
        updateLangButtons();
        if (isListening) {
            stopListening();
            startListening();
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
            wordListInput.value = clipText;
            updateParsedCount(clipText);
        } catch (_) {
            alert("Надайте дозвіл на читання буфера обміну або вставте текст вручну.");
        }
    });

    cancelEditorBtn.addEventListener("click", () => {
        editorModal.classList.add("hidden");
    });

    saveWordsBtn.addEventListener("click", () => {
        saveRawWords(wordListInput.value);
        editorModal.classList.add("hidden");
        if (isListening) {
            stopListening();
            startListening();
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
