"""Maintainer-only: regenerate the fixed, fictional repository fixtures. Never run by seeding."""
from pathlib import Path
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.lib.colors import HexColor

ROOT = Path(__file__).resolve().parent
NAVY, MUTED, GRID = map(HexColor, ('#182f43', '#586b7a', '#e2e8ed'))

def drawing(name, upper=False):
    width,height=landscape(A3)
    c=Canvas(str(ROOT/name),pagesize=(width,height),invariant=1)
    c.setTitle('Musterplanung - Obergeschoss' if upper else 'Musterplanung - Erdgeschoss')
    c.setAuthor('sortsys - fiktive Beispieldaten')
    c.setStrokeColor(NAVY); c.setFillColor(NAVY)
    c.setFont('Helvetica-Bold',22);c.drawString(54,height-55,'Musterhaus | '+('Obergeschoss' if upper else 'Erdgeschoss'))
    c.setFont('Helvetica',10);c.setFillColor(MUTED);c.drawString(54,height-75,'Schematischer Beispielplan - nicht zur Bauausführung verwenden')
    x,y,scale=170,165,.065
    c.setLineWidth(.3);c.setStrokeColor(GRID)
    for gx in range(0,12001,1000): c.line(x+gx*scale,y,x+gx*scale,y+8000*scale)
    for gy in range(0,8001,1000): c.line(x,y+gy*scale,x+12000*scale,y+gy*scale)
    lines=[(0,0,12000,0),(12000,0,12000,8000),(12000,8000,0,8000),(0,8000,0,0),
           (200,200,11800,200),(11800,200,11800,7800),(11800,7800,200,7800),(200,7800,200,200),
           (4000,200,4000,3200),(4000,4100,4000,7800),(8000,200,8000,3200),(8000,4100,8000,7800),
           (200,4000,3000,4000),(3900,4000,7000,4000),(7900,4000,11800,4000)]
    c.setStrokeColor(NAVY);c.setLineWidth(2)
    for a,b,d,e in lines:c.line(x+a*scale,y+b*scale,x+d*scale,y+e*scale)
    rooms=['Büro 1','Besprechung','Büro 2','Archiv','Flur / Treppe','Teeküche'] if upper else ['Wohnen','Essen / Küche','Abstellraum','Schlafen','Flur / Treppe','Bad']
    c.setFillColor(NAVY)
    for index,title in enumerate(rooms):
        xx=x+(2000+(index%3)*4000)*scale; yy=y+(2000+(index//3)*4000)*scale
        c.setFont('Helvetica-Bold',12);c.drawCentredString(xx,yy+6,title)
        c.setFont('Helvetica',10);c.drawCentredString(xx,yy-12,'ca. 14,4 m²')
    c.setLineWidth(.8)
    for center in [4000,8000]:
        c.line(x+center*scale,y+3200*scale,x+(center+800)*scale,y+3200*scale)
        c.arc(x+(center-800)*scale,y+2400*scale,x+(center+800)*scale,y+4000*scale,0,90)
    c.setFont('Helvetica',10);c.drawCentredString(x+6000*scale,y-25,'12,00 m')
    c.drawString(x+12000*scale+15,y+4000*scale,'8,00 m')
    c.setStrokeColor(GRID);c.line(54,115,width-54,115)
    c.setFillColor(NAVY);c.setFont('Helvetica-Bold',11);c.drawString(54,90,'Malerbetrieb Beispiel GmbH')
    c.setFont('Helvetica',9);c.drawString(54,73,'Beispielweg 12 | 06108 Halle (Saale) | Deutschland')
    c.drawString(width-350,90,'Plan: '+('GR-02' if upper else 'GR-01')+' | Stand 05.11.2026 | Revision A')
    c.drawString(width-350,73,'Alle Maße sind fiktiv. Darstellung schematisch.')
    c.showPage();c.save()
    # Owned ASCII DXF source, converted once to DWG with LibreDWG.
    import ezdxf
    doc=ezdxf.new("R2000")
    doc.layers.new("WAENDE",dxfattribs={"color":7})
    doc.layers.new("RAEUME",dxfattribs={"color":5})
    model=doc.modelspace()
    for a,b,d,e in lines: model.add_line((a,b),(d,e),dxfattribs={"layer":"WAENDE"})
    for index,title in enumerate(rooms):
        model.add_text(title,dxfattribs={"height":220,"insert":(1000+(index%3)*4000,2000+(index//3)*4000),"layer":"RAEUME"})
    doc.saveas(ROOT/name.replace('.pdf','.dxf'))

def letter(name,title,paragraphs):
    w,h=A4;c=Canvas(str(ROOT/name),pagesize=A4,invariant=1);c.setTitle(title);c.setAuthor('sortsys - fiktive Beispieldaten')
    c.setFillColor(NAVY);c.setFont('Helvetica-Bold',17);c.drawString(50,h-60,'Malerbetrieb Beispiel GmbH')
    c.setFont('Helvetica',10);c.drawString(50,h-80,'Beispielweg 12 | 06108 Halle (Saale)')
    c.setStrokeColor(GRID);c.line(50,h-100,w-50,h-100)
    c.setFont('Helvetica-Bold',20);c.drawString(50,h-155,title)
    c.setFont('Helvetica',11);y=h-195
    import textwrap
    for p in paragraphs:
        for line in textwrap.wrap(p,83):c.drawString(50,y,line);y-=18
        y-=15
    c.setFillColor(MUTED);c.setFont('Helvetica',9);c.drawString(50,50,'Fiktives statisches Beispiel für die sortsys Entwicklungsumgebung | 05.11.2026')
    c.showPage();c.save()

drawing('grundriss-erdgeschoss.pdf')
drawing('grundriss-obergeschoss.pdf',True)
letter('baubesprechung.pdf','Protokoll der Baubesprechung',[
    'Projekt: Sanierung Musterhaus, Beispielstraße 20 in Halle (Saale). Teilnehmende: Anna Beispiel (Bauleitung), Jan Muster (Auftragnehmer).',
    '1. Die Flächen im Erdgeschoss sind vor Beginn der Beschichtungsarbeiten gemeinsam aufzunehmen. Die Aufmaße werden positionsweise dokumentiert.',
    '2. Die Lieferung der Dämmplatten ist für Montag vorgesehen. Die Nachunternehmeranfrage für das Gerüst enthält nur die vereinbarten Leistungen.',
    '3. Zusätzliche Leibungsarbeiten werden als Nachtragsangebot beschrieben. Die Beauftragung erfolgt gesondert.',
    'Nächste Abstimmung: 12.11.2026, 09:00 Uhr. Dieses Dokument ist ein frei erfundenes Beispiel.'])
letter('materialfreigabe.pdf','Materialfreigabe - Musterflächen',[
    'Bauteil: Innenwände und Decken im Musterhaus. Leistung: Spachtelung, Grundierung und zweifacher Anstrich.',
    'Die Musterfläche im Besprechungsraum wurde gemeinsam angesehen. Farbton: Weiß, Oberfläche: matt. Die Beschichtung ist in den angrenzenden Räumen fortzuführen.',
    'Untergrundvorbereitung: lose Bestandteile entfernen, Flächen reinigen und Saugfähigkeit prüfen. Anschlüsse und angrenzende Bauteile abdecken.',
    'Freigabe durch Anna Beispiel am 05.11.2026. Alle Firmen, Personen, Termine und Angaben dieser Beispieldatei sind fiktiv.'])
