import type { DomainModel, OperatingMode, Provenance, Resource, Service } from '../../contracts/src/index.js';

const provenance: Provenance = { source: 'MOST fixture 2026-10-03 v1, dane syntetyczne', checkedAt: '2026-10-03T10:00:00.000Z', synthetic: true };
export function createDemoModel(): DomainModel {
  const service = (id: string, name: string, unit: string, minimum: number, priority: number, tolerated: number): Service => ({ id, name, outcome: name, unit, minimum, priority, weight: 1, toleratedOutageMinutes: tolerated, ownerId: 'owner', deputyId: 'coordinator', location: 'centrum', version: 1, provenance });
  const person = (id: string, name: string, skills: string[]): Resource => ({ id, name, type: 'person', unit: 'osoba', quantity: 1, state: 'available', confidence: 'confirmed', location: 'centrum', skills, tags: [], availableUntilMinute: 120, provenance });
  const mode = (id: string, serviceId: string, name: string, level: number, setupMinutes: number, skills: string[], count: number): OperatingMode => ({ id, serviceId, name, level, setupMinutes, autonomyMinutes: 120, requirements: [{ id: `${id}-staff`, type: 'person', quantity: count, unit: 'osoba', skills, phase: 'both' }], procedureId: `procedure-${id}`, procedureVersion: 1, approved: true, verificationContractId: `verify-${id}`, location: 'centrum', provenance });
  const modes = [mode('help-local', 'help', 'Rejestr lokalny', 6, 15, ['pomoc'], 2), mode('coord-radio', 'coordination', 'Radio niezależne', 12, 5, ['radio'], 1), mode('water-generator', 'water', 'Agregat przy pompie', 100, 30, ['pompa'], 1)];
  modes[1].dependencyId = 'radio-battery';
  modes[1].requirements.push({ id: 'radio-device', type: 'equipment', quantity: 1, unit: 'szt.', tags: ['radio'], phase: 'both' });
  modes[2].requirements.push({ id: 'generator-power', type: 'equipment', quantity: 1, unit: 'szt.', tags: ['generator', 'pump-compatible'], requiredCapacity: 3, capacityUnit: 'kW', phase: 'both' }, { id: 'generator-fuel', type: 'consumable', quantity: 1, unit: 'l', tags: ['diesel'], consumptionPerMinute: 0.02, setupConsumption: 0.1, phase: 'operation' });
  for (const [id, serviceId, name, level] of [['help-digital', 'help', 'Rejestr centralny', 12], ['coord-digital', 'coordination', 'Łączność cyfrowa', 12], ['water-grid', 'water', 'Pompa sieciowa', 150]] as const) {
    const normal = mode(id, serviceId, name, level, 0, [], 1); normal.dependencyId = serviceId === 'water' ? 'grid-power' : 'digital-connection'; modes.push(normal);
  }
  return {
    schemaVersion: 1, id: 'gmina-blackout-v1', organizationId: 'most-demo', revision: 1, name: 'Awaria zasilania i wspólnego routera', synthetic: true, referenceTime: '2026-10-03T10:00:00.000Z', horizonMinutes: 120, stepMinutes: 5,
    services: [service('help', 'Punkt pomocy', 'zgłoszeń/h', 6, 1, 20), service('coordination', 'Koordynacja', 'meldunków/h', 12, 1, 10), service('water', 'Dystrybucja wody', 'l/h (symulacja)', 100, 2, 30)],
    modes,
    resources: [person('person-1', 'Anna, punkt pomocy', ['pomoc']), person('person-2', 'Bartek, punkt pomocy', ['pomoc']), person('person-3', 'Celina, radio', ['radio']), person('person-4', 'Daniel, pompa', ['pompa']),
      { id: 'generator-1', name: 'Agregat G1, kompatybilny', type: 'equipment', unit: 'szt.', quantity: 1, state: 'available', confidence: 'confirmed', location: 'centrum', skills: [], tags: ['generator', 'pump-compatible'], capacity: 5, capacityUnit: 'kW', physicalReleaseConfirmed: true, provenance },
      { id: 'radio-1', name: 'Radiotelefon R1', type: 'equipment', unit: 'szt.', quantity: 1, state: 'available', confidence: 'confirmed', location: 'centrum', skills: [], tags: ['radio'], physicalReleaseConfirmed: true, provenance },
      { id: 'fuel-1', name: 'Potwierdzony zapas paliwa', type: 'consumable', unit: 'l', quantity: 5, state: 'available', confidence: 'confirmed', location: 'centrum', skills: [], tags: ['diesel'], provenance }],
    dependencies: [
      { id: 'grid-power', name: 'Zasilanie usług', kind: 'leaf', inputs: [], state: 'unavailable', confidence: 'confirmed', provenance },
      { id: 'router', name: 'Wspólny router', kind: 'leaf', inputs: [], state: 'unavailable', confidence: 'confirmed', provenance },
      { id: 'fiber', name: 'Światłowód', kind: 'leaf', inputs: [], state: 'available', confidence: 'confirmed', provenance },
      { id: 'lte', name: 'LTE, stan niepotwierdzony', kind: 'leaf', inputs: [], state: 'unknown', confidence: 'unverified', provenance },
      { id: 'uplink', name: 'Światłowód lub LTE', kind: 'or', inputs: ['fiber', 'lte'], provenance },
      { id: 'digital-connection', name: 'Łączność cyfrowa', kind: 'and', inputs: ['grid-power', 'router', 'uplink'], provenance },
      { id: 'radio-battery', name: 'Niezależna bateria radia', kind: 'leaf', inputs: [], state: 'available', confidence: 'confirmed', availableUntilMinute: 120, provenance },
      { id: 'app-lan', name: 'Osobny LAN aplikacji', kind: 'leaf', inputs: [], state: 'available', confidence: 'confirmed', availableUntilMinute: 120, provenance },
    ],
    procedures: modes.map(m => ({ id: m.procedureId, version: 1, title: `Procedura: ${m.name}`, approved: true, approvedBy: 'owner', steps: ['Potwierdź obsadę i warunki początkowe.', 'Wykonaj zatwierdzony przebieg ćwiczenia.', 'Zapisz zakończenie oraz osobny wynik testu.'], prerequisites: ['Zatwierdzony przydział', 'Dostępne i sprawdzone zasoby'], safetyNote: 'Dane syntetyczne. To nie jest instrukcja obsługi instalacji. W terenie obowiązuje zatwierdzona procedura właściciela.', provenance })),
    verificationContracts: modes.map(m => ({ id: m.verificationContractId, version: 1, modeId: m.id, title: `Test: ${m.name}`, expectedResult: m.id === 'help-local' ? 'Zapisz i odczytaj testowe zgłoszenie w lokalnym rejestrze.' : 'Wykonaj testowy przebieg i dołącz dowód z symulatora.', metric: 'Poziom usługi', minimum: m.level, unit: m.serviceId === 'water' ? 'l/h (symulacja)' : m.serviceId === 'help' ? 'zgłoszeń/h' : 'meldunków/h', validityMinutes: 120, verifierRoles: ['operator', 'coordinator', 'owner'], evidenceRequired: true, mandatory: true, simulated: m.id !== 'help-local', provenance })),
    reservations: [], uncertainties: [{ id: 'check-person-4', subjectId: 'person-4', question: 'Czy Daniel jest dostępny do obsługi pompy?', verificationMinutes: 2, contact: 'Zatwierdzony katalog: Daniel, kanał lokalny 4' }, { id: 'check-lte', subjectId: 'lte', question: 'Czy LTE działa?', verificationMinutes: 5, contact: 'Zatwierdzony katalog: dyżurny łączności' }], travelTimes: [],
    allocationScopes: [{ id: 'scope-demo', resourceIds: ['person-1', 'person-2', 'person-3', 'person-4', 'generator-1', 'radio-1', 'fuel-1'], modeIds: modes.map(m => m.id), authorizedUserId: 'coordinator', validFrom: '2026-10-03T00:00:00.000Z', validUntil: '2026-10-04T23:59:59.000Z', modelRevision: 1, allowLocalReplanning: true, conditions: ['Wyłącznie syntetyczne ćwiczenie', 'Bez nowych globalnych przydziałów'] }],
  };
}

export interface DomainScenario { id: string; version: 1; title: string; description: string; expected: { minimumMinutes?: number; maxMinimumMinutes?: number; validModel?: boolean; noResourceId?: string; status?: string; dependency?: [string, string] }; model: DomainModel }
export function createScenario(id: string): DomainModel { return structuredClone(domainScenarios().find(s => s.id === id)?.model ?? createDemoModel()); }
export function domainScenarios(): DomainScenario[] {
  const fixtures: DomainScenario[] = [];
  const add = (id: string, title: string, change: (m: DomainModel) => void, expected: DomainScenario['expected']) => { const model = createDemoModel(); change(model); model.id = id; fixtures.push({ id, version: 1, title, description: title, expected, model }); };
  add('baseline', 'Cztery osoby, 310 usługominut', () => {}, { minimumMinutes: 310, validModel: true });
  add('three-persons', 'Brak czwartej osoby', m => { m.resources[3].state = 'unavailable'; }, { minimumMinutes: 220, noResourceId: 'person-4' });
  add('uncertain-person', 'Niepotwierdzona czwarta osoba', m => { m.resources[3].state = 'unknown'; m.resources[3].confidence = 'unverified'; }, { minimumMinutes: 220, noResourceId: 'person-4' });
  add('untrusted-person', 'Dostępność bez potwierdzenia źródła', m => { m.resources[3].confidence = 'unverified'; }, { minimumMinutes: 220, noResourceId: 'person-4' });
  add('no-generator', 'Brak agregatu', m => { m.resources.find(r => r.id === 'generator-1')!.state = 'unavailable'; }, { minimumMinutes: 220 });
  add('incompatible-generator', 'Niezgodne wyposażenie', m => { m.resources.find(r => r.id === 'generator-1')!.tags = ['generator']; }, { minimumMinutes: 220 });
  add('underpowered-generator', 'Niewystarczająca moc', m => { m.resources.find(r => r.id === 'generator-1')!.capacity = 2; }, { minimumMinutes: 220 });
  add('fuel-shortage', 'Mały zapas paliwa', m => { m.resources.find(r => r.id === 'fuel-1')!.quantity = 0.5; }, { minimumMinutes: 240 });
  add('no-fuel', 'Brak paliwa', m => { m.resources.find(r => r.id === 'fuel-1')!.quantity = 0; }, { minimumMinutes: 220 });
  add('uncertain-delivery', 'Niepotwierdzona dostawa', m => { m.resources.find(r => r.id === 'fuel-1')!.confidence = 'unverified'; }, { minimumMinutes: 220 });
  add('radio-autonomy', 'Bateria radia do 60 minuty', m => { m.dependencies.find(d => d.id === 'radio-battery')!.availableUntilMinute = 60; }, { minimumMinutes: 250 });
  add('mode-autonomy', 'Tryb wody z autonomią 30 minut', m => { m.modes[2].autonomyMinutes = 30; }, { minimumMinutes: 250 });
  add('delayed-person', 'Przyjazd obsługi w minucie 20', m => { m.resources[3].availableFromMinute = 20; }, { minimumMinutes: 290 });
  add('travel', 'Przejazd 10 minut', m => { m.resources[3].location = 'baza'; m.travelTimes.push({ from: 'baza', to: 'centrum', minutes: 10 }); }, { minimumMinutes: 300 });
  add('missing-travel', 'Brak czasu przejazdu', m => { m.resources[3].location = 'baza'; }, { minimumMinutes: 220 });
  add('unapproved-procedure', 'Procedura bez zatwierdzenia', m => { m.procedures[2].approved = false; }, { minimumMinutes: 220 });
  add('missing-owner', 'Brak właściciela', m => { m.services[0].ownerId = ''; }, { validModel: false, status: 'invalid_model' });
  add('duplicate-id', 'Duplikat identyfikatora', m => { m.resources[1].id = m.resources[0].id; }, { validModel: false, status: 'invalid_model' });
  add('dependency-cycle', 'Cykl wyłącza fragment, tryby niezależne pozostają', m => { m.dependencies.find(d => d.id === 'uplink')!.inputs.push('digital-connection'); }, { validModel: true, minimumMinutes:310 });
  add('missing-dependency', 'Brak wejścia wyłącza fragment, tryby niezależne pozostają', m => { m.dependencies.find(d => d.id === 'uplink')!.inputs.push('missing'); }, { validModel: true, minimumMinutes:310 });
  add('hard-deadline', 'Niewykonalny twardy termin', m => { m.services[2].hardDeadlineMinute = 10; }, { status: 'infeasible' });
  add('rounding', 'Konserwatywne zaokrąglenie 16 do 20 minut', m => { m.modes[0].setupMinutes = 16; }, { minimumMinutes: 305 });
  add('occupied-generator', 'Sprzęt bez fizycznego zwrotu', m => { m.resources.find(r => r.id === 'generator-1')!.occupied = true; m.resources.find(r => r.id === 'generator-1')!.physicalReleaseConfirmed = false; }, { minimumMinutes: 220 });
  add('expired-reservation', 'Koniec rezerwacji bez potwierdzenia zwrotu', m => { m.reservations.push({ id: 'old', resourceId: 'generator-1', planId: 'old-plan', startMinute: -30, endMinute: -1, quantity: 1, status: 'in_use' }); }, { minimumMinutes: 220 });
  add('released-reservation', 'Potwierdzony zwrot sprzętu', m => { m.reservations.push({ id: 'old', resourceId: 'generator-1', planId: 'old-plan', startMinute: -30, endMinute: -1, quantity: 1, status: 'released', releaseConfirmedAt: m.referenceTime }); }, { minimumMinutes: 310 });
  add('common-cause', 'Wspólna przyczyna zalania', m => { m.dependencies.push({ id: 'flood', name: 'Pomieszczenie suche', kind: 'leaf', inputs: [], state: 'unavailable', confidence: 'confirmed', provenance }); m.dependencies.find(d => d.id === 'fiber')!.commonCauseId = 'flood'; }, { dependency: ['fiber', 'unavailable'] });
  add('no-persons', 'Brak obsady jest niedoborem, nie sprzecznością', m => { m.resources.filter(r => r.type === 'person').forEach(r => r.state = 'unavailable'); }, { minimumMinutes: 0, status: 'optimal' });
  add('short-horizon', 'Horyzont 60 minut', m => { m.horizonMinutes = 60; }, { minimumMinutes: 130 });
  return fixtures;
}
export const DEMO_EXPECTATIONS = { minimumServiceMinutes: 310, outageServiceMinutes: 50, simultaneousMinimumFromMinute: 30, starts: { help: 15, coordination: 5, water: 30 } } as const;
