//! Reproducible native documents and committed example files for development.
use super::{SeedResult, SeedRng};
use crate::{
    AppState,
    ids::Id,
    object_storage::{self, Audience, EnabledStorage},
    xml_documents,
};
use chrono::{Duration, NaiveDate, Utc};
use serde_json::json;
use sqlx::{PgConnection, PgPool};
use std::collections::HashMap;
mod takeoff;

const MANIFEST: &str = "native-contractor-documents-v1";
pub const PHASES: &[&str] = &[
    "80", "81", "82", "83", "84", "85", "86", "87", "31", "52", "89", "93", "94", "96", "97",
];
pub const ORGANIZATION_ADDRESS: &str = r#"<Address><Name1>Malerbetrieb Beispiel GmbH</Name1><Street>Beispielweg 12</Street><PCode>06108</PCode><City>Halle (Saale)</City><Country>Deutschland</Country></Address>"#;
const CUSTOMER_ADDRESS: &str = r#"<Address><Name1>Auftraggeber Musterhaus</Name1><Street>Musterstraße 20</Street><PCode>06108</PCode><City>Halle (Saale)</City><Country>Deutschland</Country></Address>"#;
const WORK: &[(&str, &str, &str)] = &[
    (
        "Innenwandanstrich, zweifach",
        "Untergrund reinigen und grundieren. Innenflächen zweimal mit matter Dispersionsfarbe beschichten. Angrenzende Bauteile schützen.",
        "m²",
    ),
    (
        "Spachtelung von Wandflächen Q3",
        "Fehlstellen schließen und Übergänge nacharbeiten. Fläche vollflächig spachteln, schleifen und für die Folgebeschichtung vorbereiten.",
        "m²",
    ),
    (
        "Dämmplatten an der Fassade",
        "Dämmplatten auf vorbereitetem Untergrund verkleben und verdübeln. Anschlüsse an Fenster und Türen fachgerecht ausbilden.",
        "m²",
    ),
    (
        "Leibungen und Fensteranschlüsse",
        "Leibungsflächen vorbereiten. Anschlussprofile liefern, einarbeiten und die Oberfläche für den Anstrich glätten.",
        "m",
    ),
    (
        "Abdecken und Schutzmaßnahmen",
        "Böden und Einbauten mit Schutzvlies und Folie abdecken. Schutz während der Arbeiten erhalten und nach Abschluss entfernen.",
        "m²",
    ),
    (
        "Gerüst für Fassadenarbeiten",
        "Arbeitsgerüst für die beschriebenen Fassadenflächen stellen, vorhalten und nach Abschluss der Arbeiten abbauen.",
        "m²",
    ),
    (
        "Trockenbau-Vorsatzschale",
        "Unterkonstruktion montieren und mit Gipskarton beplanken. Fugen und Befestigungspunkte nach der vereinbarten Qualitätsstufe verspachteln.",
        "m²",
    ),
    (
        "Sockelbeschichtung außen",
        "Sockelflächen reinigen, Unebenheiten nacharbeiten und die abgestimmte Beschichtung in zwei Arbeitsgängen auftragen.",
        "m²",
    ),
    (
        "Türzarge lackieren",
        "Alte Beschichtung anschleifen, Flächen reinigen und grundieren. Zarge zweimal im abgestimmten Farbton lackieren.",
        "Stk",
    ),
    (
        "Baustellenreinigung",
        "Arbeitsbereiche und Verkehrsflächen von arbeitsbedingten Verschmutzungen reinigen. Verpackungen und Schutzmaterial getrennt aufnehmen.",
        "psch",
    ),
    (
        "Ausgleichsmörtel in Aussparungen",
        "Aussparungen und Fehlstellen vorbereiten, mit geeignetem Ausgleichsmörtel schließen und die Oberfläche bündig nacharbeiten.",
        "m³",
    ),
];
#[derive(Clone)]
struct Position {
    id: String,
    title: String,
    description: String,
    qty: i64,
    unit: String,
    price: i64,
    measures: Vec<takeoff::Measure>,
}
fn escape(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn number(v: i64, scale: u32) -> String {
    let power = 10_i64.pow(scale);
    format!(
        "{}.{:0width$}",
        v / power,
        v % power,
        width = scale as usize
    )
}
fn money(v: i64) -> String {
    number(v, 2)
}
fn line_total(p: &Position) -> i64 {
    (p.qty * p.price + 5000) / 10000
}
fn total(rows: &[Position]) -> i64 {
    rows.iter().map(line_total).sum()
}
fn positions(rng: &mut SeedRng, scope: usize) -> Vec<Position> {
    let count = 8 + rng.range(9);
    (0..count).map(|index| {
        // Every contract has suitable source positions for lengths, surfaces,
        // volumes, counts and partial lump-sum performance. Details stay random.
        let work = [0, 3, 10, 8, 9, 1].get(index).copied().unwrap_or_else(|| rng.range(WORK.len()));
        let (title, body, unit) = WORK[work];
        Position {
            id: format!("position_{scope}_{index}"),
            title: format!("{title} - Bereich {}", 1 + rng.range(6)),
            description: format!("{body}\nAusführung in Bauabschnitt {}. Die Angaben dieser Beispieldatei sind frei erfunden.", 1 + rng.range(4)),
            qty: match unit {
                "psch" => 1000,
                "Stk" => (10 + rng.range(20) as i64) * 1000,
                "m³" => 5000 + rng.range(25000) as i64,
                _ => 60000 + rng.range(180000) as i64,
            },
            unit: unit.to_owned(), price: 5000 + rng.range(90000) as i64,
            measures: Vec::new(),
        }
    }).collect()
}
fn description(p: &Position) -> String {
    let paragraphs = p
        .description
        .split('\n')
        .map(|p| format!("<p><span>{}</span></p>", escape(p)))
        .collect::<String>();
    format!(
        "<Description><CompleteText><DetailTxt><Text>{paragraphs}</Text></DetailTxt><OutlineText><OutlTxt><TextOutlTxt><p><span style=\"font-weight:bold\">{}</span></p></TextOutlTxt></OutlTxt></OutlineText></CompleteText></Description>",
        escape(&p.title)
    )
}
fn header(phase: &str, body: &str, date: NaiveDate) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<GAEB xmlns=\"http://www.gaeb.de/GAEB_DA_XML/DA{phase}/3.3\"><GAEBInfo><Version>3.3</Version><VersDate>{}</VersDate><Date>{date}</Date><ProgSystem>sortsys</ProgSystem><ProgName>sortsys Demo</ProgName></GAEBInfo>{body}</GAEB>\n",
        if phase == "31" { "2023-01" } else { "2021-05" }
    )
}
fn boq(phase: &str, title: &str, rows: &[Position]) -> String {
    let priced = !["81", "83", "31"].contains(&phase);
    let breakdown = "<BoQBkdn><Type>BoQLevel</Type><Length>2</Length><Num>Yes</Num></BoQBkdn><BoQBkdn><Type>Item</Type><Length>4</Length><Num>Yes</Num></BoQBkdn>";
    let info = if phase == "31" {
        format!(
            "<RefBoQName>{}</RefBoQName>{breakdown}",
            escape(&title.chars().take(20).collect::<String>())
        )
    } else {
        format!(
            "<BoQInfo><Name>{}</Name>{}{breakdown}{}</BoQInfo>",
            escape(&title.chars().take(20).collect::<String>()),
            if phase == "84" {
                String::new()
            } else {
                format!(
                    "<LblBoQ>{}</LblBoQ><OutlCompl>AllTxt</OutlCompl>",
                    escape(&title.chars().take(60).collect::<String>())
                )
            },
            if priced {
                format!("<Totals><Total>{}</Total></Totals>", money(total(rows)))
            } else {
                String::new()
            }
        )
    };
    let mut address = 0;
    let items=rows.iter().enumerate().map(|(index,p)|{
  let fields=if phase=="31"{takeoff::quantity_xml(p, &mut address)}else{
   format!("<{}>{}</{}>{}{}{}{}",if phase=="89"{"BillQty"}else{"Qty"},number(p.qty,3),if phase=="89"{"BillQty"}else{"Qty"},if phase=="84"{String::new()}else{format!("<QU>{}</QU>",escape(&p.unit))},if priced{format!("<UP>{}</UP><IT>{}</IT>",number(p.price,3),money(line_total(p)))}else{String::new()},if phase=="84"{String::new()}else{description(p)},if phase=="52"{format!("<CostApproach Key=\"Lohn\"><CostApproachQty>0.250</CostApproachQty><CostApproachQU>h</CostApproachQU><Value>{}</Value></CostApproach>",number(22000+(index as i64*1250),3))}else{String::new()})
  };
  format!("<Item ID=\"{}\" RNoPart=\"{}\">{fields}</Item>",p.id,index+1)
 }).collect::<String>();
    format!(
        "<BoQ ID=\"boq\">{info}<BoQBody><BoQCtgy ID=\"section_1\" RNoPart=\"01\">{}<BoQBody><Itemlist>{items}</Itemlist></BoQBody>{}</BoQCtgy></BoQBody></BoQ>",
        if ["84", "31"].contains(&phase) {
            String::new()
        } else {
            "<LblTx><p><span style=\"font-weight:bold\">Ausbau und Oberflächen</span></p></LblTx>"
                .to_owned()
        },
        if priced {
            format!("<Totals><Total>{}</Total></Totals>", money(total(rows)))
        } else {
            String::new()
        }
    )
}
fn native(phase: &str, title: &str, rows: &[Position], date: NaiveDate) -> String {
    let body = if phase == "31" {
        let measured = takeoff::prepare(rows, &mut SeedRng::new(42));
        return takeoff::document(title, takeoff::FILE_TITLE, title, &measured, date);
    } else if ["93", "94", "96", "97"].contains(&phase) {
        let items=rows.iter().enumerate().map(|(index,p)|format!("<OrderItem ID=\"{}\"><ArtNo>MAT-{:04}</ArtNo><Qty>{}</Qty><QU>{}</QU>{}{}<OrderPosNo>{}</OrderPosNo></OrderItem>",p.id,index+1,number(p.qty/10,2),escape(&p.unit),description(p),if phase=="93"{String::new()}else{format!("<NetPrice>{}</NetPrice><PriceBasis>1.00</PriceBasis>",money((p.price+5)/10))},index+1)).collect::<String>();
        format!(
            "<PrjInfo><NamePrj>{}</NamePrj></PrjInfo><Order><DP>{phase}</DP><OrderInfo><Cur>EUR</Cur></OrderInfo>{items}</Order>",
            escape(&title.chars().take(20).collect::<String>())
        )
    } else {
        format!(
            "<Award><DP>{phase}</DP><AwardInfo><Cur>EUR</Cur></AwardInfo>{}{}{}{}</Award>",
            if ["80", "81", "82", "83", "52", "86", "87"].contains(&phase) {
                format!("<OWN>{CUSTOMER_ADDRESS}<CntryType>EEA</CntryType></OWN>")
            } else {
                String::new()
            },
            if phase != "83" {
                format!("<CTR>{ORGANIZATION_ADDRESS}<CntryType>EEA</CntryType></CTR>")
            } else {
                String::new()
            },
            if ["80", "81", "82", "52", "86", "87"].contains(&phase) {
                format!("<CnstSite>{CUSTOMER_ADDRESS}</CnstSite>")
            } else {
                String::new()
            },
            boq(phase, title, rows)
        )
    };
    header(phase, &body, date)
}
#[derive(Clone)]
struct Billed {
    number: String,
    date: NaiveDate,
    net: i64,
    gross: i64,
    paid: i64,
}
fn invoice_xml(
    title: &str,
    rows: &[Position],
    kind: &str,
    invoice_number: &str,
    date: NaiveDate,
    prior: &[Billed],
) -> String {
    let net = total(rows);
    let vat = (net * 19 + 50) / 100;
    let deduction = prior.iter().map(|p| p.gross).sum::<i64>();
    let invoice_type = match kind {
        "progress_invoice" => "deduction",
        "final_invoice" => "final account",
        _ => "single invoice",
    };
    let previous=prior.iter().map(|p|format!("<InvoiceMadeOut><TotalVAT>{}</TotalVAT><Total>{}</Total><InvoiceDate>{}</InvoiceDate><InvoiceType>deduction</InvoiceType><InvoiceNo>{}</InvoiceNo></InvoiceMadeOut>",money(p.gross-p.net),money(p.net),p.date,escape(&p.number))).collect::<String>();
    let payments=prior.iter().filter(|p|p.paid>0).map(|p|format!("<PaymentMade><TotalVAT>{}</TotalVAT><Total>{}</Total><PaymentDate>{}</PaymentDate><InvoiceType>deduction</InvoiceType><InvoiceNo>{}</InvoiceNo></PaymentMade>",money(p.paid*19/119),money(p.paid-p.paid*19/119),p.date,escape(&p.number))).collect::<String>();
    header(
        "89",
        &format!(
            "<Invoice><DP>89</DP><CnstSite>{CUSTOMER_ADDRESS}</CnstSite>{}<InvoiceHeader><InvoiceNo>{}</InvoiceNo><InvoiceDate>{date}</InvoiceDate><InvoiceType>{invoice_type}</InvoiceType><SettlementType>periodic</SettlementType><ServiceProvisionStartDate>{}</ServiceProvisionStartDate><ServiceProvisionEndDate>{date}</ServiceProvisionEndDate></InvoiceHeader><InvoiceCreator>{ORGANIZATION_ADDRESS}<TaxNo>DEMO-UST-001</TaxNo></InvoiceCreator><InvoiceRecipient><Address><Name1>Auftraggeber Musterhaus</Name1><Street>Musterstraße 20</Street><PCode>06108</PCode><City>Halle (Saale)</City></Address></InvoiceRecipient><InvoiceShare><InvoiceShareType>basic amount</InvoiceShareType><Description>Leistungswert netto</Description><Total>{}</Total></InvoiceShare><InvoiceShare><InvoiceShareType>VAT</InvoiceShareType><Description>Umsatzsteuer 19 %</Description><Percent>19.00</Percent></InvoiceShare>{}{payments}{previous}<TotalGross>{}</TotalGross></Invoice>",
            boq("89", title, rows),
            escape(invoice_number),
            date - Duration::days(14),
            money(net),
            if deduction > 0 {
                format!(
                    "<InvoiceShare><InvoiceShareType>amount invoices</InvoiceShareType><Description>Bereits gestellte Abschlagsrechnungen brutto</Description><Total>{}</Total></InvoiceShare>",
                    money(deduction)
                )
            } else {
                String::new()
            },
            money(net + vat - deduction)
        ),
        date,
    )
}
/// Same constructors are exercised against the official XSDs outside a database.
pub fn write_validation_fixtures(path: &std::path::Path, seed: u64) -> SeedResult<()> {
    std::fs::create_dir_all(path)?;
    let mut rng = SeedRng::new(seed);
    let rows = positions(&mut rng, 1);
    let date = NaiveDate::from_ymd_opt(2026, 11, 6).unwrap();
    for phase in PHASES {
        let xml = if *phase == "89" {
            invoice_xml("Musterauftrag", &rows, "invoice", "DEMO-0001", date, &[])
        } else {
            native(phase, "Musterauftrag", &rows, date)
        };
        std::fs::write(path.join(format!("demo.x{phase}")), xml)?;
    }
    Ok(())
}

struct Seeder<'a> {
    connection: &'a mut PgConnection,
    storage: EnabledStorage,
    actor: i64,
    sequence: usize,
    date: NaiveDate,
}
impl Seeder<'_> {
    // Fixture builders keep the native document chain explicit at each call site.
    #[allow(clippy::too_many_arguments)]
    async fn case(
        &mut self,
        kind: &str,
        title: &str,
        status: &str,
        project: Option<i64>,
        parent: Option<i64>,
        customer: Option<i64>,
        scope: &[Position],
    ) -> SeedResult<i64> {
        self.sequence += 1;
        let prefix = match kind {
            "offer" => "ANG",
            "alternative" => "NEB",
            "variation" => "NTR",
            "subcontract" => "VER",
            "measurement" => "AUF",
            "procurement" => "BES",
            "calculation" => "KAL",
            _ => "RE",
        };
        let id:i64=sqlx::query_scalar("INSERT INTO commercial_cases(reference,kind,status,title,project_id,parent_case_id,customer_id,scope_item_ids,accepted_at,created_by_user_id,created_at) VALUES($1||'-'||TO_CHAR(NOW(),'YYYY')||'-'||LPAD(nextval('commercial_case_number_seq')::text,6,'0'),$2,$3,$4,$5,$6,$7,$8,CASE WHEN $3='accepted' THEN NOW()-INTERVAL '7 days' ELSE NULL END,$9,NOW()-INTERVAL '30 days') RETURNING id")
   .bind(prefix).bind(kind).bind(status).bind(title.chars().take(127).collect::<String>()).bind(project).bind(parent).bind(customer).bind(json!(scope.iter().map(|p|&p.id).collect::<Vec<_>>())).bind(self.actor).fetch_one(&mut *self.connection).await?;
        let chain: Vec<&str> = match status {
            "draft" => vec!["draft"],
            "sent" => vec!["draft", "sent"],
            "accepted" => vec!["draft", "sent", "accepted"],
            "rejected" => vec!["draft", "sent", "rejected"],
            "cancelled" => vec!["draft", "cancelled"],
            "requested" => vec!["draft", "requested"],
            "awarded" => vec!["draft", "requested", "awarded"],
            "confirmed" => vec!["draft", "requested", "awarded", "confirmed"],
            "submitted" => vec!["draft", "submitted"],
            "approved" if kind == "calculation" => vec!["draft", "approved"],
            "approved" => vec!["draft", "submitted", "approved"],
            "partially_paid" => vec!["draft", "sent", "partially_paid"],
            "paid" => vec!["draft", "sent", "paid"],
            _ => vec!["draft"],
        };
        for (index, state) in chain.iter().enumerate() {
            sqlx::query("INSERT INTO commercial_case_events(case_id,action,previous_status,status,created_by_user_id,created_at) VALUES($1,$2,$3,$4,$5,NOW()-INTERVAL '30 days'+$6*INTERVAL '1 day')").bind(id).bind(if index==0{"created"}else if *state=="paid"||*state=="partially_paid"{"payment_recorded"}else{"status_changed"}).bind(if index==0{None}else{Some(chain[index-1])}).bind(state).bind(self.actor).bind(index as i64).execute(&mut *self.connection).await?;
        }
        Ok(id)
    }
    // Fixture builders keep the native document chain explicit at each call site.
    #[allow(clippy::too_many_arguments)]
    async fn document(
        &mut self,
        case: i64,
        purpose: &str,
        phase: &str,
        title: &str,
        xml: String,
        read_only: bool,
        source: Option<i64>,
        partner: Option<&str>,
        net: Option<i64>,
    ) -> SeedResult<i64> {
        let filename = format!(
            "{}{}.x{phase}",
            title
                .chars()
                .take(90)
                .collect::<String>()
                .replace(['/', '\\'], "-"),
            partner.map(|p| format!(" - {p}")).unwrap_or_default()
        );
        let key = object_storage::build_commercial_object_key(&self.storage, Id(case), &filename);
        xml_documents::upload_xml(&self.storage, &key, &xml).await?;
        let id:i64=sqlx::query_scalar("INSERT INTO commercial_documents(case_id,purpose,phase,file_name,object_key,size_bytes,read_only,source_document_id,source_version,partner_name,net_amount,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8::bigint IS NULL THEN NULL ELSE 1 END,$9,$10::numeric,$11) RETURNING id")
   .bind(case).bind(purpose).bind(phase).bind(filename).bind(&key).bind(xml.len() as i64).bind(read_only).bind(source).bind(partner).bind(net.map(money)).bind(self.actor).fetch_one(&mut *self.connection).await?;
        if read_only {
            sqlx::query("INSERT INTO commercial_document_snapshots(document_id,version,object_key,event) VALUES($1,1,$2,'seeded_fixed_revision')").bind(id).bind(key).execute(&mut *self.connection).await?;
        }
        if purpose == "offer" || purpose == "alternative" || purpose == "invoice" {
            sqlx::query("UPDATE commercial_cases SET net_amount=$2::numeric WHERE id=$1 AND kind<>'subcontract'").bind(case).bind(net.map(money)).execute(&mut *self.connection).await?;
        }
        Ok(id)
    }
    // Fixture builders keep the native document chain explicit at each call site.
    #[allow(clippy::too_many_arguments)]
    async fn quote(
        &mut self,
        kind: &str,
        title: &str,
        status: &str,
        project: Option<i64>,
        parent: Option<i64>,
        customer: Option<i64>,
        rows: &[Position],
    ) -> SeedResult<(i64, i64, i64)> {
        let case = self
            .case(kind, title, status, project, parent, customer, rows)
            .await?;
        let inquiry = self
            .document(
                case,
                "inquiry",
                "83",
                title,
                native("83", title, rows, self.date),
                status != "draft",
                None,
                None,
                None,
            )
            .await?;
        let bid = self
            .document(
                case,
                "offer",
                "84",
                title,
                native("84", title, rows, self.date),
                status != "draft",
                Some(inquiry),
                None,
                Some(total(rows)),
            )
            .await?;
        Ok((case, inquiry, bid))
    }
    async fn financial(&mut self, case: i64, project: i64, kind: &str, net: i64) -> SeedResult<()> {
        sqlx::query("INSERT INTO project_financial_entries(project_id,type,amount,comment,created_by_user_id,commercial_case_id) SELECT $1,$2,$3::numeric::double precision,reference||': '||title,$4,id FROM commercial_cases WHERE id=$5 ON CONFLICT(commercial_case_id) DO NOTHING").bind(project).bind(kind).bind(money(net)).bind(self.actor).bind(case).execute(&mut *self.connection).await?;
        Ok(())
    }
}
impl Seeder<'_> {
    // Fixture builders keep the native document chain explicit at each call site.
    #[allow(clippy::too_many_arguments)]
    async fn invoice(
        &mut self,
        kind: &str,
        title: &str,
        status: &str,
        project: i64,
        parent: i64,
        source: i64,
        customer: Option<i64>,
        rows: &[Position],
        basis: &str,
        previous: &[Billed],
    ) -> SeedResult<Billed> {
        let case = self
            .case(
                kind,
                title,
                status,
                Some(project),
                Some(parent),
                customer,
                rows,
            )
            .await?;
        let issued = matches!(status, "sent" | "partially_paid" | "paid");
        let net = total(rows);
        let prior_net = previous.iter().map(|p| p.net).sum::<i64>();
        let prior_gross = previous.iter().map(|p| p.gross).sum::<i64>();
        let gross = net + (net * 19 + 50) / 100 - prior_gross;
        sqlx::query("INSERT INTO commercial_invoice_details(case_id,basis,invoice_date,due_date,service_start,service_end,total_net,deducted_net,gross_amount) VALUES($1,$2,$3,$3+14,$3-14,$3,$4::numeric,$5::numeric,$6::numeric)").bind(case).bind(basis).bind(self.date).bind(money(net)).bind(money(prior_net)).bind(money(gross)).execute(&mut *self.connection).await?;
        let number = if issued {
            crate::procedures::commercial_billing::allocate_number(
                self.connection,
                Id(project),
                self.date,
            )
            .await?
        } else {
            "ENTWURF".to_owned()
        };
        let xml = invoice_xml(title, rows, kind, &number, self.date, previous);
        self.document(
            case,
            "invoice",
            "89",
            if issued { &number } else { title },
            xml,
            status != "draft",
            Some(source),
            None,
            Some(net - prior_net),
        )
        .await?;
        if issued {
            sqlx::query("UPDATE commercial_invoice_details SET invoice_number=$2 WHERE case_id=$1")
                .bind(case)
                .bind(&number)
                .execute(&mut *self.connection)
                .await?;
            self.financial(case, project, "invoice", net - prior_net)
                .await?;
        }
        let paid = match status {
            "paid" => gross,
            "partially_paid" => gross / 3,
            _ => 0,
        };
        if paid > 0 {
            sqlx::query("INSERT INTO commercial_invoice_payments(case_id,amount,paid_on,reference,created_by_user_id) VALUES($1,$2::numeric,$3,'Fiktiver Zahlungseingang',$4)").bind(case).bind(money(paid)).bind(self.date).bind(self.actor).execute(&mut *self.connection).await?;
        }
        Ok(Billed {
            number,
            date: self.date,
            net: net - prior_net,
            gross,
            paid,
        })
    }
    async fn files(&mut self, project: i64) -> SeedResult<()> {
        let mut folders = HashMap::new();
        for asset in ASSETS {
            let folder = if let Some(id) = folders.get(asset.folder) {
                *id
            } else {
                let id:i64=sqlx::query_scalar("INSERT INTO project_file_folders(project_id,name,created_by_user_id) VALUES($1,$2,$3) ON CONFLICT(project_id,COALESCE(parent_folder_id,0),LOWER(name)) DO UPDATE SET name=EXCLUDED.name RETURNING id").bind(project).bind(asset.folder).bind(self.actor).fetch_one(&mut *self.connection).await?;
                folders.insert(asset.folder, id);
                id
            };
            let key = format!(
                "{}/seeds/{MANIFEST}/projects/{}/{}",
                self.storage
                    .key_prefix
                    .as_deref()
                    .unwrap_or("")
                    .trim_matches('/'),
                Id(project).encode(),
                asset.name
            )
            .trim_start_matches('/')
            .to_owned();
            let signed = object_storage::create_upload_url(
                &self.storage,
                &key,
                asset.mime,
                Audience::Internal,
            )?;
            let response = reqwest::Client::new()
                .put(signed.upload_url)
                .header(reqwest::header::CONTENT_TYPE, asset.mime)
                .body(asset.bytes)
                .send()
                .await?
                .error_for_status()?;
            let etag = response
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.trim_matches('"').to_owned());
            sqlx::query("INSERT INTO project_files(project_id,storage_bucket,object_key,file_name,mime_type,kind,size_bytes,status,etag,created_by_user_id,uploaded_at,folder_id) VALUES($1,$2,$3,$4,$5,'file',$6,'uploaded',$7,$8,NOW(),$9) ON CONFLICT(object_key) DO NOTHING")
    .bind(project).bind(&self.storage.bucket).bind(key).bind(asset.name).bind(asset.mime).bind(asset.bytes.len() as i64).bind(etag).bind(self.actor).bind(folder).execute(&mut *self.connection).await?;
        }
        Ok(())
    }
}
struct Asset {
    name: &'static str,
    mime: &'static str,
    folder: &'static str,
    bytes: &'static [u8],
}
macro_rules! asset {
    ($name:literal,$mime:literal,$folder:literal) => {
        Asset {
            name: $name,
            mime: $mime,
            folder: $folder,
            bytes: include_bytes!(concat!("../../../seed-assets/", $name)),
        }
    };
}
const ASSETS: &[Asset] = &[
    asset!("grundriss-erdgeschoss.dwg", "image/vnd.dwg", "Pläne"),
    asset!("grundriss-obergeschoss.dwg", "image/vnd.dwg", "Pläne"),
    asset!("grundriss-erdgeschoss.pdf", "application/pdf", "Pläne"),
    asset!("grundriss-obergeschoss.pdf", "application/pdf", "Pläne"),
    asset!("baubesprechung.pdf", "application/pdf", "Unterlagen"),
    asset!("materialfreigabe.pdf", "application/pdf", "Unterlagen"),
    asset!("baubesprechung.eml", "message/rfc822", "Schriftverkehr"),
    asset!("materialfreigabe.eml", "message/rfc822", "Schriftverkehr"),
    asset!(
        "baubesprechung.msg",
        "application/vnd.ms-outlook",
        "Schriftverkehr"
    ),
    asset!(
        "materialfreigabe.msg",
        "application/vnd.ms-outlook",
        "Schriftverkehr"
    ),
];

pub async fn extend_development(
    state: &AppState,
    tenant: &str,
    pool: &PgPool,
    seed: u64,
) -> SeedResult<()> {
    let replay_seed = seed;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(MANIFEST)
        .execute(&mut *tx)
        .await?;
    let done: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM development_seed_manifests WHERE name=$1)")
            .bind(MANIFEST)
            .fetch_one(&mut *tx)
            .await?;
    if done {
        sqlx::query("SELECT set_config('sortsys.actor_kind','seed',true),set_config('sortsys.actor_id','',true),set_config('sortsys.actor_name','',true)").execute(&mut *tx).await?;
        takeoff::extend_existing(state, tenant, &mut tx, seed).await?;
        tx.commit().await?;
        return Ok(());
    }
    sqlx::query("SELECT set_config('sortsys.actor_kind','seed',true),set_config('sortsys.actor_id','',true),set_config('sortsys.actor_name','',true)").execute(&mut *tx).await?;
    let actor: i64 = sqlx::query_scalar(
        "SELECT id FROM users ORDER BY CASE WHEN username='john.doe' THEN 0 ELSE 1 END,id LIMIT 1",
    )
    .fetch_one(&mut *tx)
    .await?;
    let mut projects:Vec<(i64,String,Option<i64>)>=sqlx::query_as("SELECT p.id,p.title,p.customer_id FROM projects p WHERE p.finished_at IS NULL AND NOT EXISTS(SELECT 1 FROM commercial_cases c WHERE c.project_id=p.id AND c.kind='offer') ORDER BY p.id LIMIT 24").fetch_all(&mut *tx).await?;
    let customers: Vec<i64> = sqlx::query_scalar("SELECT id FROM customers ORDER BY id")
        .fetch_all(&mut *tx)
        .await?;
    if customers.is_empty() {
        return Err("Development document seeding needs customers".into());
    }
    while projects.len() < 12 {
        let title = format!("Musterprojekt für native Dokumente {}", projects.len() + 1);
        let customer = customers[projects.len() % customers.len()];
        let id:i64=sqlx::query_scalar("INSERT INTO projects(title,customer_id,responsible_project_leader_user_id) VALUES($1,$2,$3) RETURNING id").bind(&title).bind(customer).bind(actor).fetch_one(&mut *tx).await?;
        projects.push((id, title, Some(customer)));
    }
    let storage = xml_documents::required_storage(state, tenant).await?;
    let mut rng = SeedRng::new(seed);
    let date = Utc::now().date_naive();
    let mut seed = Seeder {
        connection: &mut tx,
        storage,
        actor,
        sequence: 0,
        date,
    };
    let statuses = ["draft", "sent", "accepted", "rejected", "cancelled"];
    // Standalone requests and sales offers, including accepted offers before a project.
    for i in 0..15 {
        let rows = positions(&mut rng, 1000 + i);
        let status = statuses[i % statuses.len()];
        let title = format!(
            "{} - {}",
            [
                "Innenausbau Praxis",
                "Fassadensanierung",
                "Treppenhaus renovieren"
            ][i % 3],
            i + 1
        );
        if i % 5 == 0 {
            let case = seed
                .case(
                    "offer",
                    &title,
                    "draft",
                    None,
                    None,
                    Some(customers[i % customers.len()]),
                    &rows,
                )
                .await?;
            seed.document(
                case,
                "inquiry",
                "83",
                &title,
                native("83", &title, &rows, date),
                false,
                None,
                None,
                None,
            )
            .await?;
        } else {
            seed.quote(
                "offer",
                &title,
                status,
                None,
                None,
                Some(customers[i % customers.len()]),
                &rows,
            )
            .await?;
        }
    }
    for (index, (project, title, customer)) in projects.iter().enumerate() {
        let rows = positions(&mut rng, index);
        let customer = customer.or(Some(customers[index % customers.len()]));
        let (main, inquiry, bid) = seed
            .quote(
                "offer",
                title,
                "accepted",
                Some(*project),
                None,
                customer,
                &rows,
            )
            .await?;
        let order = seed
            .document(
                main,
                "order",
                "86",
                title,
                native("86", title, &rows, date),
                true,
                Some(bid),
                None,
                Some(total(&rows)),
            )
            .await?;
        if index % 3 != 2 {
            seed.document(
                main,
                "confirmation",
                "87",
                title,
                native("87", title, &rows, date),
                index % 2 == 0,
                Some(order),
                None,
                Some(total(&rows)),
            )
            .await?;
        }
        seed.financial(main, *project, "offer", total(&rows))
            .await?;
        if index < 10 {
            let changed = positions(&mut rng, 2000 + index);
            let status = statuses[index % 5];
            let name = format!("Zusätzliche Leibungsarbeiten - Bauabschnitt {}", index + 1);
            let (case, _, _) = seed
                .quote(
                    "variation",
                    &name,
                    status,
                    Some(*project),
                    Some(main),
                    customer,
                    &changed,
                )
                .await?;
            if status == "accepted" {
                seed.financial(case, *project, "offer", total(&changed))
                    .await?;
            }
            let alternative = seed
                .case(
                    "alternative",
                    "Alternative Materialausführung",
                    status,
                    Some(*project),
                    Some(main),
                    customer,
                    &changed,
                )
                .await?;
            seed.document(
                alternative,
                "alternative",
                "85",
                "Nebenangebot - alternative Beschichtung",
                native("85", "Alternative Beschichtung", &changed, date),
                status != "draft",
                Some(inquiry),
                None,
                Some(total(&changed)),
            )
            .await?;
        }
        if index < 12 {
            let status = ["draft", "submitted", "approved", "cancelled"][index % 4];
            let measured = takeoff::prepare(&rows, &mut rng);
            let case = seed
                .case(
                    "measurement",
                    "Aufmaß - Bauabschnitt 1",
                    status,
                    Some(*project),
                    Some(main),
                    customer,
                    &measured,
                )
                .await?;
            seed.document(
                case,
                "measurement",
                "31",
                takeoff::FILE_TITLE,
                takeoff::document(title, takeoff::FILE_TITLE, title, &measured, date),
                status != "draft",
                Some(order),
                None,
                None,
            )
            .await?;
            let status = ["draft", "requested", "awarded", "confirmed", "cancelled"][index % 5];
            let scope = rows.iter().take(3).cloned().collect::<Vec<_>>();
            let case = seed
                .case(
                    "subcontract",
                    "Gerüst- und vorbereitende Leistungen",
                    status,
                    Some(*project),
                    Some(main),
                    customer,
                    &scope,
                )
                .await?;
            let ask = seed
                .document(
                    case,
                    "inquiry",
                    "83",
                    "Nachunternehmeranfrage",
                    native("83", "Leistungspaket", &scope, date),
                    status != "draft",
                    Some(order),
                    None,
                    None,
                )
                .await?;
            if matches!(status, "requested" | "awarded" | "confirmed") {
                let mut chosen = None;
                for company in ["Muster Gerüstbau GmbH", "Ausbau Demo GmbH"] {
                    let mut prices = scope.clone();
                    for p in &mut prices {
                        p.price = p.price * (65 + rng.range(25) as i64) / 100;
                    }
                    let offer = seed
                        .document(
                            case,
                            "offer",
                            "84",
                            "Nachunternehmerangebot",
                            native("84", "Leistungspaket", &prices, date),
                            true,
                            Some(ask),
                            Some(company),
                            Some(total(&prices)),
                        )
                        .await?;
                    if chosen.is_none() {
                        chosen = Some((offer, prices, company));
                    }
                }
                if matches!(status, "awarded" | "confirmed") {
                    let (offer, prices, company) = chosen.unwrap();
                    let purchase = seed
                        .document(
                            case,
                            "order",
                            "86",
                            "Beauftragung Nachunternehmer",
                            native("86", "Leistungspaket", &prices, date),
                            true,
                            Some(offer),
                            Some(company),
                            Some(total(&prices)),
                        )
                        .await?;
                    sqlx::query("UPDATE commercial_cases SET selected_offer_document_id=$2,net_amount=$3::numeric,counterparty_name=$4 WHERE id=$1").bind(case).bind(offer).bind(money(total(&prices))).bind(company).execute(&mut *seed.connection).await?;
                    if status == "confirmed" {
                        seed.document(
                            case,
                            "confirmation",
                            "87",
                            "Nachunternehmerbestätigung",
                            native("87", "Leistungspaket", &prices, date),
                            true,
                            Some(purchase),
                            Some(company),
                            Some(total(&prices)),
                        )
                        .await?;
                    }
                }
            }
        }
        if index < 10 {
            let status = ["draft", "requested", "awarded", "confirmed", "cancelled"][index % 5];
            let mut materials = rows.iter().take(3).cloned().collect::<Vec<_>>();
            for (i, p) in materials.iter_mut().enumerate() {
                p.title = [
                    "Gipskartonplatten 12,5 mm",
                    "Tiefgrund für Innenflächen",
                    "Dispersionsfarbe weiß, matt",
                ][i]
                    .to_owned();
                p.description="Materiallieferung frei Baustelle. Verpackungen und Anlieferung mit der Bauleitung abstimmen.".to_owned();
                p.unit = ["Stk", "l", "l"][i].to_owned();
                // Trade quantities and prices use two decimals. Keep the case
                // amount identical to the native OrderItem calculation.
                p.qty = p.qty / 10 * 10;
                p.price = (p.price + 5) / 10 * 10;
            }
            let case = seed
                .case(
                    "procurement",
                    "Material für den Innenausbau",
                    status,
                    Some(*project),
                    Some(main),
                    None,
                    &materials,
                )
                .await?;
            let ask = seed
                .document(
                    case,
                    "price_inquiry",
                    "93",
                    "Materialpreisanfrage",
                    native("93", "Materialbedarf", &materials, date),
                    status != "draft",
                    None,
                    Some("Baustoffhandel Muster GmbH"),
                    None,
                )
                .await?;
            if matches!(status, "requested" | "awarded" | "confirmed") {
                let offer = seed
                    .document(
                        case,
                        "supplier_offer",
                        "94",
                        "Lieferantenpreisangebot",
                        native("94", "Materialbedarf", &materials, date),
                        true,
                        Some(ask),
                        Some("Baustoffhandel Muster GmbH"),
                        Some(total(&materials)),
                    )
                    .await?;
                if matches!(status, "awarded" | "confirmed") {
                    let purchase = seed
                        .document(
                            case,
                            "purchase_order",
                            "96",
                            "Materialbestellung",
                            native("96", "Materialbedarf", &materials, date),
                            true,
                            Some(offer),
                            Some("Baustoffhandel Muster GmbH"),
                            Some(total(&materials)),
                        )
                        .await?;
                    sqlx::query("UPDATE commercial_cases SET selected_offer_document_id=$2,counterparty_name='Baustoffhandel Muster GmbH',net_amount=$3::numeric WHERE id=$1").bind(case).bind(offer).bind(money(total(&materials))).execute(&mut *seed.connection).await?;
                    if status == "confirmed" {
                        seed.document(
                            case,
                            "supplier_confirmation",
                            "97",
                            "Lieferantenbestätigung",
                            native("97", "Materialbedarf", &materials, date),
                            true,
                            Some(purchase),
                            Some("Baustoffhandel Muster GmbH"),
                            Some(total(&materials)),
                        )
                        .await?;
                    }
                }
            }
        }
        if index < 4 {
            let status = if index % 2 == 0 { "draft" } else { "approved" };
            let case = seed
                .case(
                    "calculation",
                    "Lohn- und Materialansätze",
                    status,
                    Some(*project),
                    Some(main),
                    customer,
                    &rows,
                )
                .await?;
            seed.document(
                case,
                "calculation",
                "52",
                "Kalkulationsansätze",
                native("52", "Lohn und Material", &rows, date),
                status != "draft",
                Some(order),
                None,
                Some(total(&rows)),
            )
            .await?;
        }
        if index < 5 {
            let status = ["draft", "sent", "partially_paid", "paid", "cancelled"][index];
            seed.invoice(
                "invoice",
                "Rechnung ohne Abschläge",
                status,
                *project,
                main,
                order,
                customer,
                &rows,
                "work",
                &[],
            )
            .await?;
        } else if index < 10 {
            let mut work = rows.clone();
            for p in &mut work {
                p.qty /= 5;
            }
            let first = seed
                .invoice(
                    "progress_invoice",
                    "Abschlag nach erbrachter Leistung",
                    "paid",
                    *project,
                    main,
                    order,
                    customer,
                    &work,
                    "work",
                    &[],
                )
                .await?;
            let lump=Position{id:format!("advance_{index}"),title:"Pauschaler Abschlag auf den Baufortschritt".to_owned(),description:"Vereinbarter pauschaler Abschlag. Die abschließende Abrechnung erfolgt nach den Vertragsleistungen.".to_owned(),qty:1000,unit:"psch".to_owned(),price:total(&rows)*10/6,measures:Vec::new()};
            let second = seed
                .invoice(
                    "progress_invoice",
                    "Pauschaler Abschlag",
                    if index % 2 == 0 {
                        "partially_paid"
                    } else {
                        "sent"
                    },
                    *project,
                    main,
                    order,
                    customer,
                    &[lump],
                    "lump_sum",
                    &[],
                )
                .await?;
            seed.invoice(
                "final_invoice",
                "Schlussrechnung mit Abschlägen",
                ["draft", "sent", "paid", "partially_paid", "draft"][index - 5],
                *project,
                main,
                order,
                customer,
                &rows,
                "work",
                &[first, second],
            )
            .await?;
        }
        if index < 6 {
            seed.files(*project).await?;
        }
        if index < 3 {
            let folder:i64=sqlx::query_scalar("INSERT INTO project_file_folders(project_id,name,created_by_user_id) VALUES($1,'Leistungskataloge',$2) RETURNING id").bind(project).bind(actor).fetch_one(&mut *seed.connection).await?;
            for phase in ["80", "81", "82"] {
                let xml = native(phase, "Leistungskatalog", &rows, date);
                let name = format!("Musterkatalog.x{phase}");
                let key =
                    object_storage::build_project_object_key(&seed.storage, Id(*project), &name);
                xml_documents::upload_xml(&seed.storage, &key, &xml).await?;
                sqlx::query("INSERT INTO project_files(project_id,storage_bucket,object_key,file_name,mime_type,kind,size_bytes,status,created_by_user_id,uploaded_at,folder_id) VALUES($1,$2,$3,$4,'application/vnd.gaeb+xml','file',$5,'uploaded',$6,NOW(),$7)").bind(project).bind(&seed.storage.bucket).bind(key).bind(name).bind(xml.len() as i64).bind(actor).bind(folder).execute(&mut *seed.connection).await?;
            }
        }
    }
    sqlx::query("INSERT INTO development_seed_manifests(name,seed) VALUES($1,$2)")
        .bind(MANIFEST)
        .bind(replay_seed.to_string())
        .execute(&mut *seed.connection)
        .await?;
    takeoff::extend_existing(state, tenant, seed.connection, replay_seed).await?;
    tx.commit().await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_positions_are_reproducible_and_readable() {
        let a = positions(&mut SeedRng::new(42), 3);
        let b = positions(&mut SeedRng::new(42), 3);
        assert_eq!(
            native(
                "83",
                "Muster",
                &a,
                NaiveDate::from_ymd_opt(2026, 11, 6).unwrap()
            ),
            native(
                "83",
                "Muster",
                &b,
                NaiveDate::from_ymd_opt(2026, 11, 6).unwrap()
            )
        );
        assert!(a.len() >= 8);
        assert!(
            a.iter()
                .all(|p| p.title.len() > 10 && p.description.len() > 50 && p.qty > 0)
        );
    }
    #[test]
    fn static_files_match_the_committed_manifest() {
        use sha2::{Digest, Sha256};
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../seed-assets/manifest.json")).unwrap();
        assert_eq!(ASSETS.len(), 10);
        for asset in ASSETS {
            let record = manifest
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == asset.name)
                .unwrap();
            assert_eq!(record["size"], asset.bytes.len());
            assert_eq!(
                record["sha256"],
                Sha256::digest(asset.bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );
        }
    }
}
