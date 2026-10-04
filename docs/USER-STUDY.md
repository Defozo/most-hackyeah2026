# Próba wdrożeniowa

Próbę prowadzi się z docelowymi koordynatorami i wykonawcami, na danych syntetycznych i bez danych mieszkańców. Poniższy protokół służy zaplanowaniu własnego pilotażu; nie jest raportem z przeprowadzonego badania.

## Zadania uczestników

1. Przy pełnej obsadzie znajdź wspólną przyczynę awarii i zaplanuj utrzymanie minimów trzech usług.
2. Przy trzech potwierdzonych osobach i czwartej niepotwierdzonej wskaż informację do sprawdzenia przed decyzją.
3. Przygotuj urządzenie, odłącz serwer i uwzględnij utratę osoby we wcześniej przyznanej puli. Przelicz plan, zapisz meldunek i wyeksportuj dane.
4. Wykonaj zadanie i osobny test. Rozróżnij wynik potwierdzony, nieustalony i negatywny.

## Porównanie sposobów pracy

Porównaj MOST z kartami i arkuszem na równoważnych danych, z tymi samymi minimami, zasobami i prawami. Zmieniaj kolejność metod między uczestnikami. Oddzielnie porównaj nowe lokalne obliczenie z wyborem wcześniej zapisanych wariantów.

Zapisuj czas do decyzji, poprawność przydziałów, rozpoznanie niepewności, rozróżnienie wykonania i wyniku oraz liczbę interwencji prowadzącego. Wyniki uczestników oceniaj oddzielnie od czasu pracy solvera.

## Przygotowanie organizacji

Zmierz czas opisania pierwszej usługi, kolejnych usług i aktualizacji procedury. Właściciel usługi podaje źródła, jednostki i uprawnienia, a następnie sprawdza znany dobry stan. Po pilotażu zatwierdź dane, procedury, odpowiedzialność za aktualizacje i sposób wykonywania kopii.

Materiały z bieżącego modelu tworzy `pnpm exec tsx ops/study-materials.ts`. Przykładowe kolumny arkusza wyników: `participant,role,variant,method,order,decision_seconds,valid_allocation,recognized_uncertainty,distinguished_result,facilitator_interventions,setup_minutes,notes`.
