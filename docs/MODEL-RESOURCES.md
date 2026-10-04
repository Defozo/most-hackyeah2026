# Jednostki zasobów i ich przydział

Zasób odnawialny (`person`, `equipment`) ma ilość `quantity`. Przydział (`Allocation`) i rezerwacja (`Reservation`) wskazują konkretne logiczne sztuki tej puli przez `unitIds`, na przykład `radio-1#1` i `radio-1#2`. Każda sztuka ma oddzielnie sprawdzaną zajętość, dostępność i trasę przejazdu. Dwie różne sztuki mogą pracować równocześnie w różnych miejscach, jeżeli każda zdąży tam dotrzeć.

Sufiksy `#1`, `#2` są stałymi indeksami logicznymi, także dla starszych modeli z samą ilością. Nie są numerami inwentarzowymi ani dowodem rozpoznania fizycznego egzemplarza. Przed rozpoczęciem operator musi przypisać tym oznaczeniom rozróżnialne egzemplarze i potwierdzić dostępność. Gdy potrzebna jest osobna ewidencja źródła, miejsca lub stanu sztuki, należy opisać ją jako osobny zasób z `quantity: 1` i własnym identyfikatorem.

W kolejnych aktywnych przedziałach tego samego zapotrzebowania jednej czynności pozostaje ten sam zestaw jednostek. Solver nie zastępuje fizycznego przekazania zamianą indeksów w połowie pracy. Zapotrzebowania `setup` i `operation` obowiązują w swoich fazach. Po użyciu sprzętu jego fizyczny zwrot nadal wymaga jawnego potwierdzenia; sam upływ czasu rezerwacji nie zwalnia sztuki oznaczonej jako używana.

Przydział grupy wymaga tylu różnych `unitIds`, ile wynosi jego ilość. Starszy przydział pojedynczego zasobu bez `unitIds` jest czytany jako `#1`. Starsza rezerwacja ilościowa bez oznaczeń konserwatywnie zajmuje odpowiednią liczbę sztuk, a nazwana rezerwacja blokuje tylko wskazane sztuki.

Opcjonalne `Resource.dependencyId` wiąże zasób ze wspólną przyczyną, na przykład zalaniem pomieszczenia. Niedostępność tej zależności wyklucza wszystkie wskazujące ją zasoby. Zgodny zamiennik poza tą zależnością pozostaje dostępny. Paliwa, energia i inne materiały zużywalne zachowują osobny bilans ilościowy i nie korzystają z indeksów sztuk.
