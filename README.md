# Wix Static Site Scraper

GitHub Action שמריץ Puppeteer, סורק את כל אתר ה-Wix שלך דף דף, ומוריד הכל כאתר סטטי מוכן להורדה.

## שימוש

### הרצה ידנית (workflow_dispatch)

1. לך ל-**Actions** → **Wix Static Site Scraper** → **Run workflow**
2. הכנס את כתובת האתר שלך
3. לאחר הסיום — הורד את ה-ZIP מ-**Artifacts**

### הגדרות

| Input | תיאור | ברירת מחדל |
|-------|--------|------------|
| `site_url` | URL מלא של אתר ה-Wix | חובה |
| `max_pages` | מקסימום עמודים לסרוק | 200 |
| `wait_ms` | המתנה (ms) לאחר טעינת JS | 2000 |

### משתנה קבוע (ללא הקלדה בכל פעם)

ב-Settings → Secrets and variables → Actions → **Variables**, הוסף:
```
SITE_URL = https://myname.wixsite.com/mysite
```

## מה הסקריפט עושה

1. **מריץ Chrome אמיתי** דרך Puppeteer — כולל רינדור JavaScript של Wix
2. **גולל כל עמוד** עד הסוף לטעינת תכנים lazy-loaded
3. **ממיר קישורים** מ-absolute ל-relative אוטומטית
4. **מוריד assets** — תמונות, CSS, JS
5. **יוצר sitemap.xml**
6. **מעלה ZIP** ל-Artifacts להורדה

## פריסה ל-GitHub Pages

בקובץ `scrape.yml` יש בלוק מוגן בהערות בתחתית לפריסה אוטומטית ל-Pages.
הסר את ה-`#` והפעל Pages ב-Settings.

## מגבלות

- תכנים שדורשים **התחברות** (Members, Dashboard) לא יורדו
- **Wix Forms** — יורד ה-HTML אבל הלוגיקה לא תעבוד
- **Wix Store** — דפי מוצר ירדו כסטטי, checkout לא יעבוד
