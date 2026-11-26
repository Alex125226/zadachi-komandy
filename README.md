# Задачи команды

Android-приложение для задач торговой сети: задачи, регионы, ответственные, чаты по регионам, учёт времени.

- Интерфейс: `web/` — публикуется на GitHub Pages при каждом push, приложение подхватывает его автоматически.
- Оболочка Android: Capacitor (`android/`). Новый APK собирается, только когда меняется `version` в `package.json`.
- Скачать APK: https://github.com/Alex125226/zadachi-komandy/releases/latest/download/zadachi.apk
- Данные: Supabase, таблицы `wt_*`, доступ ограничен правилами RLS.
