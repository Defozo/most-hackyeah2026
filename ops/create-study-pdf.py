"""Print cards generated from the same synthetic model as MOST, without proposed answers."""
from pathlib import Path
import json
from xml.sax.saxutils import escape
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import A4

root=Path(__file__).resolve().parent.parent
out=root/'output/pdf';out.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(TTFont('Arial','C:/Windows/Fonts/arial.ttf'))
pdfmetrics.registerFont(TTFont('ArialBold','C:/Windows/Fonts/arialbd.ttf'))
styles=getSampleStyleSheet()
for style in styles.byName.values():style.fontName='Arial';style.textColor=colors.HexColor('#173238')
styles['Title'].fontName=styles['Heading1'].fontName=styles['Heading2'].fontName='ArialBold'
styles['BodyText'].fontSize=10;styles['BodyText'].leading=15
model=json.loads((root/'artifacts/study/model.json').read_text(encoding='utf-8-sig'))
team=json.loads((root/'TEAM.json').read_text(encoding='utf-8-sig'))
story=[]
def p(text,style='BodyText'):story.append(Paragraph(escape(str(text)),styles[style]));story.append(Spacer(1,8))
def table(headers,rows,widths):
    data=[[Paragraph(escape(str(x)),styles['BodyText']) for x in row] for row in [headers]+rows]
    t=Table(data,colWidths=widths,repeatRows=1,hAlign='LEFT');t.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e3eeea')),('LINEBELOW',(0,0),(-1,-1),.5,colors.HexColor('#c8d5cf')),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8)]));story.append(t)
p('MOST: karty ćwiczenia','Title');p(team['team_name']+' | '+', '.join(team['members']))
p('Materiały równoważne do próby z PDF i arkuszem. Parametry są syntetyczne. Karty nie są instrukcją pracy z rzeczywistą instalacją.')
p('Sytuacja i reguły','Heading1');p('Utracono zasilanie sieciowe i wspólny router. Utrzymaj minima trzech usług przez 120 minut, przy kroku 5 minut. Jedna osoba lub urządzenie nie mogą w tym samym czasie wykonywać dwóch czynności. Przygotowanie także zajmuje zasoby.')
p('Najpierw maksymalizuj ważone usługominuty na minimum według kolejnych klas priorytetu. Następnie minimalizuj znormalizowany niedobór, zużycie zasobów i liczbę przełączeń. Tolerowane przerwy raportuj osobno. Niepotwierdzone zasoby nie zwiększają puli ostrożnej.')
table(['Usługa','Minimum','Tolerancja'],[[s['name'],str(s['minimum'])+' '+s['unit'],str(s['toleratedOutageMinutes'])+' min'] for s in model['services']],[180,180,115])
p('Pełne, jednakowe dane','Heading2');p('Dołączone pliki CSV opisują usługi, tryby, zasoby i zależności. model.json zawiera także wszystkie wymagania, parametry, źródła, daty sprawdzenia, kontrakty i uprawnienia. Własny arkusz musi uwzględniać te same dane oraz reguły.')
p('Zapisz plan, przydziały, brakujące informacje i powód decyzji. Prowadzący mierzy czas, poprawność oraz liczbę swoich podpowiedzi. Nie wpisuj odpowiedzi do pustego user-study.csv przed rzeczywistą próbą.')
story.append(PageBreak());p('Warianty dla prowadzącego','Title')
for title,body in [('A. Wspólna przyczyna','Cztery osoby są potwierdzone. Znajdź przyczynę awarii łączności i wykonalny plan.'),('B. Niepewna obsada','Daniel ma niepotwierdzoną dostępność. Porównaj skutek sprawdzenia jego dostępności ze sprawdzeniem LTE.'),('C. Zmiana bez serwera','Po przygotowaniu urządzenia jedna wskazana osoba przestaje być dostępna. Zachowaj tę samą pulę zasobów i uprawnień. Wyznacz nowy plan; porównaj możliwość przeliczenia z wyborem tylko zapisanych wariantów.'),('D. Wykonanie i rezultat','Po ukończeniu procedury odróżnij samo wykonanie od ważnego testu rezultatu. Wskaż, jaki dowód jest potrzebny.')]:p(title,'Heading2');p(body)
p('Kolejność metod','Heading2');p('Uczestnicy 1, 3 i 5 zaczynają od MOST, pozostali od PDF i CSV. Przy drugiej metodzie użyj równoważnego wariantu ze zmienioną kolejnością i nazwami. Zapewnij taki sam czas wprowadzenia. Rejestruj również brak przewagi aplikacji.')
p('Czas wdrożenia','Heading2');p('Osobno mierz przygotowanie pierwszej usługi, kolejnych usług oraz zmianę procedury. Właściciel podaje źródła i zatwierdza znany dobry stan. Czas pracy z formularzem nie jest czasem realizacji procedury w terenie.')
for procedure in model['procedures']:
    story.append(PageBreak());p(procedure['title'],'Title');p('Wersja '+str(procedure['version'])+' | syntetyczne ćwiczenie')
    p('Warunki','Heading2')
    for value in procedure.get('prerequisites',[]):p('• '+value)
    p('Czynności','Heading2')
    for i,value in enumerate(procedure['steps']):p(str(i+1)+'. '+value)
    p(procedure['safetyNote'])
    for mode in [m for m in model['modes'] if m['procedureId']==procedure['id']]:
        c=next(c for c in model['verificationContracts'] if c['id']==mode['verificationContractId'])
        p('Osobny test rezultatu','Heading2');p(c['expectedResult']);p('Kryterium: '+str(c['minimum'])+' '+c['unit']+'. Ważność '+str(c['validityMinutes'])+' min.')
        p('Symulacja: wynik nie potwierdza działania rzeczywistego urządzenia.' if c['simulated'] else 'Rejestr musi rzeczywiście zapisać i odczytać syntetyczne zgłoszenie.')
    p('Źródło: '+procedure['provenance']['source'])
def footer(c,doc):c.setFont('Arial',9);c.setFillColor(colors.HexColor('#52676b'));c.drawString(42,28,'MOST | Dane syntetyczne | Materiały do badania, bez wyników uczestników');c.drawRightString(A4[0]-42,28,str(doc.page))
SimpleDocTemplate(str(out/'MOST-karty-cwiczenia.pdf'),pagesize=A4,leftMargin=42,rightMargin=42,topMargin=40,bottomMargin=45,title='MOST - karty ćwiczenia',author=team['team_name']+'; '+', '.join(team['members'])).build(story,onFirstPage=footer,onLaterPages=footer)
print(out/'MOST-karty-cwiczenia.pdf')
