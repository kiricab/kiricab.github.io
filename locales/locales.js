document.addEventListener('DOMContentLoaded', () => {
    const userLang = navigator.language.split('-')[0]; // 'en-US' -> 'en'
    const supportedLangs = ['ja', 'en', 'zh', 'es'];
    const lang = supportedLangs.includes(userLang) ? userLang : 'en'; // デフォルトは英語

    // 現在のスクリプトのパスを取得し、localesフォルダへの相対パスを構築
    const scriptPath = document.currentScript.src;
    const baseUrl = scriptPath.substring(0, scriptPath.lastIndexOf('/')) + '/';

    fetch(`${baseUrl}${lang}.json`)
        .then(response => response.json())
        .then(translations => {
            // HTMLのlang属性を更新
            document.documentElement.lang = lang;
            window.translations = translations; // グローバルスコープにtranslationsを公開

            // titleとmeta descriptionの翻訳
            document.title = translations.app_title;
            const metaDescription = document.querySelector('meta[name="description"]');
            if (metaDescription && translations.app_description) {
                metaDescription.setAttribute('content', translations.app_description);
            }

            // data-i18n属性を持つ要素の翻訳
            document.querySelectorAll('[data-i18n]').forEach(element => {
                const key = element.getAttribute('data-i18n');
                if (translations[key]) {
                    element.textContent = translations[key];
                }
            });

            // data-i18n-placeholder属性を持つ要素の翻訳
            document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
                const key = element.getAttribute('data-i18n-placeholder');
                if (translations[key]) {
                    element.placeholder = translations[key];
                }
            });

            // footerの著作権表示はinnerHTMLで設定
            const footerCopyright = document.querySelector('[data-i18n="footer_copyright"]');
            if (footerCopyright && translations.footer_copyright) {
                footerCopyright.innerHTML = translations.footer_copyright;
            }
        })
        .catch(error => {
            console.error('Error loading translations:', error);
        });
});
