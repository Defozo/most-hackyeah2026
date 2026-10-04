# Źródła i licencje

Projekt odpowiada na zadanie DEFENCE HackYeah 2026.

Znaczące użycie AI: Codex wspiera implementację, przegląd kodu, testy, diagnozowanie błędów, dokumentację i przygotowanie materiałów demonstracyjnych. Dane, teksty obserwacji, parametry infrastruktury oraz osoby w fixture są syntetyczne.

Zależności główne: React i React DOM (MIT), Vite (MIT), TypeScript (Apache-2.0), Fastify (MIT), better-sqlite3 (MIT), Argon2 (MIT), Dexie (Apache-2.0), HiGHS/highs-js (MIT), React Flow (MIT), elkjs (EPL-2.0), Lucide (ISC), Radix UI (MIT), Workbox (MIT), vite-plugin-pwa (MIT), Mammoth (BSD-2-Clause), pdf-parse (Apache-2.0), csv-parse (MIT), Vitest (MIT), fast-check (MIT), Playwright (Apache-2.0), axe-core (MPL-2.0).

Dokładne wersje i drzewo rozstrzyga `pnpm-lock.yaml`. Wykaz 540 pakietów, także zależności przechodnich i narzędzi budowania, znajduje się w `output/licenses/DEPENDENCIES.json`. Pliki licencji i zawiadomień dołączono w `output/licenses`; `INDEX.json` podaje ich pochodzenie, dziedziczenie licencji binariów po pakiecie nadrzędnym oraz ewentualne pobranie z repozytorium autora. Dla `@epic-web/invariant` autor deklaruje MIT bez osobnego zawiadomienia copyright; zachowano tę deklarację i niezmieniony wzorzec SPDX. Nie dopisano fikcyjnego właściciela praw. Wydanie offline zawiera lokalną kopię solvera WASM. Zgodność podpisów Ed25519 ze starszym Chrome zapewniają `@noble/curves` i `@noble/hashes` (MIT).

Generatory materiałów PDF używają ReportLab 5.0.1 (BSD) i pypdf 6.19.0 (BSD-3-Clause). Są narzędziami przygotowania dokumentów, nie zależnościami aplikacji. Font Arial pochodzi z lokalnej instalacji Windows i jest osadzony w dokumentach; plik fontu nie jest dołączany osobno.

Dokumentacja implementacji sprawdzona podczas pracy:

- [HiGHS w JavaScript i WebAssembly](https://github.com/lovasoa/highs-js)
- [Transakcje Dexie](https://dexie.org/docs/Dexie/Dexie.transaction())
- [Serwer Fastify](https://fastify.dev/docs/latest/Reference/Server/)

Usługi opcjonalne: Groq i Firecrawl. Nazwy wymaganych zmiennych i sposób wstrzykiwania kluczy opisuje README.md. Dane aplikacji nie są automatycznie wysyłane do dostawców. Wyniki rzeczywistych wywołań należy odróżnić od samej konfiguracji i testów z atrapami.

Ikony są dostarczane lokalnie z Lucide. Nazwa MOST i znak aplikacji powstały na potrzeby rozwiązania. Nie wykorzystano fotografii rzeczywistych incydentów ani cudzych znaków służb.

Pitch z 3 października 2026 wykorzystuje rzeczywiste zrzuty i nagranie aplikacji z syntetycznym scenariuszem. Polski lektor został wygenerowany w ElevenLabs, modelem `eleven_multilingual_v2`, głosem Bella premade w ElevenLabs. Nie klonowano głosu członka zespołu. [Zasady publikacji treści ElevenLabs](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform). Podkład jest oryginalną kompozycją utworzoną lokalnie z syntetyzowanych przebiegów, bez cudzych sampli.

Nowy PPTX zawiera edytowalne elementy i notatki. Powstał przez `@oai/artifact-tool`, a PDF wyeksportowano w Microsoft PowerPoint i sprawdzono po renderowaniu. Zrzuty pochodzą wyłącznie z demonstracyjnej aplikacji MOST.
