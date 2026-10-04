# Wyłączenie wadliwego fragmentu

`validateModel` rozróżnia błąd całego modelu od fragmentu, którego nie wolno użyć. Przy lokalnym błędzie zwraca `valid: true`, jawne ostrzeżenia `fragment_excluded` i `blockedFragments` z rodzajem, identyfikatorem oraz przyczynami. To oznacza możliwość obliczenia pozostałej części, a nie potwierdzenie poprawności wyłączonych danych.

Lokalnie wyłączane są:

- cykl lub brak wejścia zależności, także w bramce OR z poprawnym drugim wejściem;
- zależne węzły, tryby i zasoby oraz ich dalsze zależności;
- brak lub cykl poprzedników czynności;
- tryb bez właściwej wersji procedury albo kontraktu;
- tryb z niepoprawnym czasem przygotowania, poziomem, autonomią, wersją lub deklaracją zatwierdzenia;
- tryby odwołujące się do procedury z wadliwymi wymaganymi polami albo do kontraktu z wadliwym progiem, rolami, czasem ważności lub wymaganymi parametrami.

Globalne błędy kształtu kolekcji, tożsamości lub duplikatów, siatki czasu, parametrów usług, zasobów i zapotrzebowań, rezerwacji oraz upoważnień nadal dają `invalid_model`. Silnik nie zgaduje jednostek, ilości ani brakujących parametrów.

Oryginalne dane i wszystkie usługi pozostają w modelu. Kompilacja MILP pomija tylko wyłączone tryby. Ich usługom nadal nalicza niedobór oraz sprawdza twarde terminy. Gdy jedyny tryb usługi jest wadliwy, a usługa ma nieprzekraczalny termin, wynikiem może być niewykonalność. Bez takiego terminu pozostałe usługi mogą mieć poprawny plan z jawnie wykazanym brakiem tej usługi.

Niezależny walidator ponownie wyznacza wyłączenia na aktualnym modelu. Odrzuca ręczne lub zmienione plany używające wyłączonego trybu (`blocked_mode`) albo zasobu (`blocked_resource`). Usunięcie ostrzeżeń z przesłanego planu nie omija sprawdzenia. Zgodny zasób zastępczy poza uszkodzoną zależnością nadal może zostać przydzielony.

Przed pracą solvera pusty harmonogram może zostać opublikowany jako dolna granica wyłącznie po niezależnej walidacji wszystkich twardych warunków. Ma status wykonalnego wyniku bez dowodu optimum, zero utrzymanych usług i jawne niedobory. Gdy pusty plan narusza twardy termin, nie jest publikowany jako wynik.
