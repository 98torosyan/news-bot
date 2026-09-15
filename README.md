# news-bot

Telegram-ի հայերեն կրիպտո/տնտեսական նորությունների ալիք։

Աշխատում է GitHub Actions-ով՝ ամեն 30 րոպեն մեկ։ Համակարգիչ պետք չէ։

## Ինչպես է որոշում ինչ հրապարակել

Թվաբանությունը, ոչ թե AI-ն։ Եթե մի պատմությունը գրել են մի քանի անկախ
աղբյուր կարճ ժամանակում՝ այն կարևոր է։ Պաշտոնական աղբյուրները (Fed, SEC,
ECB, BLS) մենակ էլ բավական են։

AI-ն միայն գրում է հայերենը։ Երբեք չի որոշում ինչ հրապարակել։

Ամեն փոստ կրում է իր պատճառը՝ «3 աղբյուր՝ CoinDesk, Decrypt, Protos»։

## Գործարկում

    node run.js --dry-run    # ցույց է տալիս, ոչինչ չի հրապարակում
    node run.js              # հրապարակում է

    node scripts/test-rank.mjs
    node scripts/test-bot.mjs
    node scripts/news-doctor.mjs   # աղբյուրների և AI-ի ստուգում

## Գաղտնիքներ (GitHub → Settings → Secrets → Actions)

    GEMINI_API_KEY
    TELEGRAM_BOT_TOKEN
    TELEGRAM_CHAT_ID

Սրանք երբեք չեն գրվում կոդի մեջ։
