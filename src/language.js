const LOCALES = { id: 'id-ID', en: 'en-US', ar: 'ar-SA', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' };

export function languageProbabilities(logits, languageTokens) {
    const candidates = Object.entries(languageTokens).map(([token, id]) => {
        if (!/^<\|[a-z]{2,3}\|>$/.test(token) || !Number.isInteger(id) || !Number.isFinite(logits[id])) {
            throw new Error('Metadata token bahasa model tidak valid.');
        }
        return { language: token.slice(2, -2), logit: logits[id] };
    });
    if (candidates.length < 2) throw new Error('Model tidak memiliki token multilingual.');
    // Exactly one decoder step, masked to language tokens, as in Whisper detect_language.
    const maximum = Math.max(...candidates.map((item) => item.logit));
    const sum = candidates.reduce((total, item) => total + Math.exp(item.logit - maximum), 0);
    return candidates.map(({ language, logit }) => ({ language, confidence: Math.exp(logit - maximum) / sum }))
        .sort((a, b) => b.confidence - a.confidence);
}

export function formatResult(probabilities, threshold, audioSeconds, speechSeconds, elapsedMs) {
    const top = probabilities[0];
    const confident = top.confidence >= threshold;
    const round = (value, digits) => Number(value.toFixed(digits));
    return {
        status: confident ? 'detected' : 'uncertain',
        language: confident ? top.language : null,
        suggested_locale: confident ? (LOCALES[top.language] ?? null) : null,
        confidence: round(top.confidence, 6),
        alternatives: probabilities.slice(0, 3).map((item) => ({ language: item.language, confidence: round(item.confidence, 6) })),
        audio_seconds: round(audioSeconds, 3),
        speech_seconds: round(speechSeconds, 3),
        processing_ms: round(elapsedMs, 1),
    };
}
