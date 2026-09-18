import { messages } from './messages.js';
import { storageKeyLocale } from '../constants.js';

export const supportedLocales = ['zh-CN', 'en'];

const detectLocale = () => {
    try {
        const stored = localStorage.getItem(storageKeyLocale);
        if (supportedLocales.includes(stored)) return stored;
    } catch { }

    const browserLanguage = String(navigator.language || '').toLowerCase();
    return browserLanguage.startsWith('zh') ? 'zh-CN' : 'en';
};

export let currentLocale = detectLocale();

// 文案缺失时回退到 en，再回退到键名本身，保证界面不出现空白。
export function t(key, replacements) {
    const table = messages[currentLocale] || messages.en;
    let text = table[key] ?? messages.en[key] ?? key;

    if (replacements) {
        for (const [name, value] of Object.entries(replacements)) {
            text = text.replace(`{${name}}`, String(value));
        }
    }
    return text;
}

export function setLocale(locale) {
    if (!supportedLocales.includes(locale)) return;
    currentLocale = locale;
    try { localStorage.setItem(storageKeyLocale, locale); } catch { }
}

export function toggleLocale() {
    setLocale(currentLocale === 'zh-CN' ? 'en' : 'zh-CN');
}
