//! Assisted X31 examples use the same versioned metadata and executable FN91
//! records as the canvas editor. All arithmetic is fixed point, never f64.
use super::*;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;

const SCALE: i128 = 1_000_000_000_000;
const MANIFEST: &str = "native-assisted-takeoffs-v1";
const LOCATION_MANIFEST: &str = "native-takeoff-locations-v2";
pub(super) const FILE_TITLE: &str = "Aufmaß Bauabschnitt 1";

#[derive(Clone, Debug, Serialize)]
pub(super) struct Measure {
    id: String,
    shape: String,
    mode: String,
    location: String,
    label: String,
    count: String,
    a: String,
    b: String,
    c: String,
    factor: String,
    expression: String,
    threshold: String,
}
fn compact(milli: i64) -> String {
    number(milli, 3)
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
}
fn milli(value: &str) -> i128 {
    let (whole, part) = value.split_once('.').unwrap_or((value, ""));
    assert!(part.len() <= 3, "seed measure precision");
    whole.parse::<i128>().unwrap() * 1000 + format!("{part:0<3}").parse::<i128>().unwrap()
}
fn round_quantity(value: i128) -> i64 {
    let result = (value.abs() + 500_000_000) / 1_000_000_000;
    i64::try_from(result * value.signum()).unwrap()
}
fn encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}
impl Measure {
    fn new(shape: &str, label: &str, location: &str) -> Self {
        Self {
            id: String::new(),
            shape: shape.to_owned(),
            mode: "add".to_owned(),
            location: location.to_owned(),
            label: label.to_owned(),
            count: "1".to_owned(),
            a: "0".to_owned(),
            b: "0".to_owned(),
            c: "0".to_owned(),
            factor: "0.67".to_owned(),
            expression: "0".to_owned(),
            threshold: String::new(),
        }
    }
    fn dimensions(mut self, a: i64, b: i64, c: i64, count: i64) -> Self {
        self.a = compact(a);
        self.b = compact(b);
        self.c = compact(c);
        self.count = compact(count);
        self
    }
    fn opening(mut self, threshold: &str) -> Self {
        self.mode = "opening".to_owned();
        self.threshold = threshold.to_owned();
        self
    }
    fn single(&self) -> i128 {
        let (a, b, c) = (milli(&self.a), milli(&self.b), milli(&self.c));
        match self.shape.as_str() {
            "count" => SCALE,
            "length" => a * 1_000_000_000,
            "area" => a * b * 1_000_000,
            "volume" => a * b * c * 1000,
            "triangle" => a * b * 1_000_000 / 2,
            "trapezoid" => (a + b) * c * 1_000_000 / 2,
            "factor" => a * b * milli(&self.factor) * 1000,
            // Seed formulas explicitly describe three-sided window joints.
            "formula" => {
                assert_eq!(self.expression, format!("2*{}+{}", self.a, self.b));
                (2 * a + b) * 1_000_000_000
            }
            _ => unreachable!("seed measure shape"),
        }
    }
    fn overmeasured(&self) -> bool {
        self.mode == "opening"
            && !self.threshold.is_empty()
            && self.single() <= milli(&self.threshold) * 1_000_000_000
    }
    fn result(&self) -> i128 {
        if self.overmeasured() {
            return 0;
        }
        self.single() * milli(&self.count) / 1000 * if self.mode == "add" { 1 } else { -1 }
    }
    fn expression(&self) -> String {
        let single = match self.shape.as_str() {
            "count" => "1".to_owned(),
            "length" => self.a.clone(),
            "area" => format!("{}*{}", self.a, self.b),
            "volume" => format!("{}*{}*{}", self.a, self.b, self.c),
            "triangle" => format!("{}*{}/2", self.a, self.b),
            "trapezoid" => format!("({}+{})*{}/2", self.a, self.b, self.c),
            "factor" => format!("{}*{}*{}", self.a, self.b, self.factor),
            "formula" => self.expression.clone(),
            _ => unreachable!(),
        };
        let base = if self.shape == "count" {
            self.count.clone()
        } else if self.count == "1" {
            single
        } else {
            format!("{}*({single})", self.count)
        };
        let expression = if self.overmeasured() {
            format!("0*({base})")
        } else if self.mode == "add" {
            base
        } else {
            format!("-({base})")
        };
        if expression.len() <= 37 {
            return expression;
        }
        let (mut a, mut b) = (self.result().abs(), SCALE);
        while b != 0 {
            (a, b) = (b, a % b);
        }
        let divisor = a.max(1);
        let (n, d) = (self.result() / divisor, SCALE / divisor);
        let result = if d == 1 {
            n.to_string()
        } else {
            format!("{n}/{d}")
        };
        assert!(result.len() <= 37, "seed REB capacity");
        result
    }
    fn xml(&self, address: usize) -> String {
        let label = self
            .label
            .chars()
            .take(9)
            .map(|c| if c.len_utf16() == 1 { c } else { '?' })
            .collect::<String>();
        let address = format!(
            "{:04}{}{}",
            address / 260 + 1,
            char::from(b'A' + ((address / 10) % 26) as u8),
            address % 10
        );
        let row = format!(
            "             {label:<9}   100091{:<38}{address}     ",
            format!("{}=", self.expression())
        );
        assert_eq!(row.chars().count(), 80);
        format!(
            "<QDetermItem><!--sortsys:measure:v1:{}--><QTakeoff Row=\"{}\"/></QDetermItem>",
            encode(&serde_json::to_string(self).unwrap()),
            escape(&row)
        )
    }
}
fn approaches(p: &Position, rng: &mut SeedRng, index: usize) -> Vec<Measure> {
    let room = format!("EG, Raum {}", 101 + index);
    let upper = format!("1. OG, Raum {}", 201 + index);
    match p.unit.as_str() {
        "m²" => vec![
            Measure::new("area", "Wandfläche Fensterseite", &room).dimensions(
                4500 + rng.range(2000) as i64,
                2700 + rng.range(500) as i64,
                0,
                1000,
            ),
            Measure::new("area", "Wandfläche gegenüber", &room).dimensions(
                3500 + rng.range(1500) as i64,
                2700 + rng.range(500) as i64,
                0,
                1000,
            ),
            Measure::new("area", "Fensteröffnung klein", &room)
                .dimensions(1200, 1500, 0, (2 + rng.range(3) as i64) * 1000)
                .opening("2.5"),
            Measure::new("area", "Öffnung genau 2,50 m²", &room)
                .dimensions(1250, 2000, 0, 2000)
                .opening("2.5"),
            Measure::new("area", "Türöffnung über 2,50 m²", &room)
                .dimensions(1600, 2100, 0, 1000)
                .opening("2.5"),
            Measure::new("factor", "Bogen über Fensterelement", &upper).dimensions(
                300,
                1830,
                0,
                (2 + rng.range(3) as i64) * 1000,
            ),
            Measure::new("triangle", "Dreieck am Treppenlauf", &upper)
                .dimensions(1600, 1200, 0, 1000),
            Measure::new("trapezoid", "Schräge Anschlussfläche", &upper)
                .dimensions(2200, 1400, 600, 1000),
        ],
        "m" | "lfm" => {
            let mut joint = Measure::new("formula", "Fensteranschluss, dreiseitig", &upper)
                .dimensions(1455, 1535, 0, 2000);
            joint.expression = format!("2*{}+{}", joint.a, joint.b);
            vec![
                Measure::new("length", "Senkrechte Anschlussfugen", &room).dimensions(
                    1455 + rng.range(500) as i64,
                    0,
                    0,
                    (4 + rng.range(5) as i64) * 1000,
                ),
                Measure::new("length", "Waagerechte Anschlussfugen", &room).dimensions(
                    1535 + rng.range(500) as i64,
                    0,
                    0,
                    (2 + rng.range(4) as i64) * 1000,
                ),
                joint,
            ]
        }
        "m³" => vec![
            Measure::new("volume", "Aussparungen mit Mörtel schließen", &room).dimensions(
                450 + rng.range(200) as i64,
                350 + rng.range(150) as i64,
                250 + rng.range(100) as i64,
                6000,
            ),
            Measure::new("volume", "Ergänzungen an Stützenfüßen", &upper)
                .dimensions(400, 400, 300, 4000),
        ],
        "psch" => vec![
            Measure::new("count", "Vorbereitung Bauabschnitt abgeschlossen", &room)
                .dimensions(0, 0, 0, 500),
        ],
        _ => vec![
            Measure::new("count", "Türzargen im Erdgeschoss", &room).dimensions(
                0,
                0,
                0,
                (2 + rng.range(3) as i64) * 1000,
            ),
            Measure::new("count", "Türzargen im Obergeschoss", &upper).dimensions(
                0,
                0,
                0,
                (2 + rng.range(3) as i64) * 1000,
            ),
        ],
    }
}
pub(super) fn prepare(rows: &[Position], rng: &mut SeedRng) -> Vec<Position> {
    let mut chosen: Vec<&Position> = Vec::new();
    for unit in ["m²", "m", "m³", "Stk", "psch"] {
        if let Some(p) = rows.iter().find(|p| p.unit == unit) {
            chosen.push(p);
        }
    }
    for p in rows {
        if chosen.len() >= 6 {
            break;
        }
        if !chosen.iter().any(|candidate| candidate.id == p.id) {
            chosen.push(p);
        }
    }
    chosen
        .into_iter()
        .enumerate()
        .map(|(index, p)| {
            let mut result = p.clone();
            result.measures = approaches(p, rng, index);
            for (i, measure) in result.measures.iter_mut().enumerate() {
                measure.id = format!("measure_{}_{}", p.id, i);
            }
            result.qty = round_quantity(result.measures.iter().map(Measure::result).sum());
            result
        })
        .collect()
}
pub(super) fn quantity_xml(p: &Position, address: &mut usize) -> String {
    assert!(
        !p.measures.is_empty(),
        "seed X31 must have actual approaches"
    );
    let qty = round_quantity(p.measures.iter().map(Measure::result).sum());
    assert_eq!(qty, p.qty);
    let rows = p
        .measures
        .iter()
        .map(|row| {
            let xml = row.xml(*address);
            *address += 1;
            xml
        })
        .collect::<String>();
    format!("<QtyDeterm><Qty>{}</Qty>{rows}</QtyDeterm>", number(qty, 3))
}
pub(super) fn document(
    project_title: &str,
    designation: &str,
    reference_title: &str,
    rows: &[Position],
    date: NaiveDate,
) -> String {
    let body = format!(
        "<QtyDeterm><PrjInfo><RefPrjName>{}</RefPrjName></PrjInfo><QtyDetermInfo><MethodDescription>REB23003-2009</MethodDescription><!--sortsys:takeoff-title:v1:{}--></QtyDetermInfo><DP>31</DP><OWN>{CUSTOMER_ADDRESS}<CntryType>EEA</CntryType></OWN><CTR>{ORGANIZATION_ADDRESS}<CntryType>EEA</CntryType></CTR>{}</QtyDeterm>",
        escape(&project_title.chars().take(60).collect::<String>()),
        encode(designation),
        boq("31", reference_title, rows)
    );
    header("31", &body, date)
}

#[derive(sqlx::FromRow)]
struct SeedContract {
    parent: i64,
    project: i64,
    title: String,
    customer: Option<i64>,
    source: i64,
    key: String,
    name: String,
}

/// A separate additive manifest upgrades existing dev databases without changing
/// any pre-existing examples or user edits, even when the original seed is done.
pub(super) async fn extend_existing(
    state: &AppState,
    tenant: &str,
    connection: &mut PgConnection,
    replay_seed: u64,
) -> SeedResult<()> {
    repair_seed_locations(state, tenant, connection).await?;
    let done: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM development_seed_manifests WHERE name=$1)")
            .bind(MANIFEST)
            .fetch_one(&mut *connection)
            .await?;
    if done {
        return Ok(());
    }
    let storage = xml_documents::required_storage(state, tenant).await?;
    let actor: i64 = sqlx::query_scalar(
        "SELECT id FROM users ORDER BY CASE WHEN username='john.doe' THEN 0 ELSE 1 END,id LIMIT 1",
    )
    .fetch_one(&mut *connection)
    .await?;
    let contracts:Vec<SeedContract>=sqlx::query_as("SELECT c.id AS parent,p.id AS project,p.title,c.customer_id AS customer,d.id AS source,d.object_key AS key,d.file_name AS name FROM commercial_cases c JOIN projects p ON p.id=c.project_id JOIN commercial_documents d ON d.case_id=c.id AND d.purpose='order' AND d.phase='86' AND d.version=1 WHERE c.kind='offer' AND c.status='accepted' AND c.created_by_user_id=$1 AND p.finished_at IS NULL AND EXISTS(SELECT 1 FROM commercial_document_snapshots s WHERE s.document_id=d.id AND s.event='seeded_fixed_revision') AND EXISTS(SELECT 1 FROM commercial_cases m WHERE m.parent_case_id=c.id AND m.kind='measurement') AND NOT EXISTS(SELECT 1 FROM commercial_cases m JOIN commercial_documents md ON md.case_id=m.id WHERE m.parent_case_id=c.id AND m.kind='measurement' AND md.file_name=$2) ORDER BY c.id LIMIT 12").bind(actor).bind(format!("{FILE_TITLE}.x31")).fetch_all(&mut *connection).await?;
    let date = Utc::now().date_naive();
    let mut rng = SeedRng::new(replay_seed);
    for (
        index,
        SeedContract {
            parent,
            project,
            title,
            customer,
            source,
            key,
            name,
        },
    ) in contracts.into_iter().enumerate()
    {
        let original = xml_documents::download_xml_object(&storage, &key, &name).await?;
        let parsed = roxmltree::Document::parse(&original)?;
        if !parsed.descendants().any(|node| {
            node.has_tag_name(("http://www.gaeb.de/GAEB_DA_XML/DA86/3.3", "ProgName"))
                && node.text() == Some("sortsys Demo")
        }) {
            continue;
        }
        let ns = parsed.root_element().tag_name().namespace();
        let mut rows = Vec::new();
        for item in parsed
            .descendants()
            .filter(|node| node.tag_name().name() == "Item" && node.tag_name().namespace() == ns)
        {
            let value = |name: &str| {
                item.children()
                    .find(|node| {
                        node.tag_name().namespace() == ns && node.tag_name().name() == name
                    })
                    .and_then(|node| node.text())
                    .unwrap_or("")
            };
            let Some(id) = item.attribute("ID") else {
                continue;
            };
            let title = item
                .descendants()
                .find(|node| node.tag_name().name() == "TextOutlTxt")
                .map(|node| {
                    node.descendants()
                        .filter(|node| node.is_text())
                        .filter_map(|node| node.text())
                        .collect::<String>()
                })
                .unwrap_or_else(|| "Bestandsleistung".to_owned());
            rows.push(Position {
                id: id.to_owned(),
                title,
                description: String::new(),
                qty: i64::try_from(milli(value("Qty")))?,
                unit: value("QU").to_owned(),
                price: i64::try_from(milli(value("UP")))?,
                measures: Vec::new(),
            });
        }
        if rows.is_empty() {
            continue;
        }
        let measured = prepare(&rows, &mut rng);
        let status = ["draft", "submitted", "approved", "cancelled"][index % 4];
        let mut seeder = Seeder {
            connection: &mut *connection,
            storage: storage.clone(),
            actor,
            sequence: 0,
            date,
        };
        let case = seeder
            .case(
                "measurement",
                "Aufmaß - Bauabschnitt 1",
                status,
                Some(project),
                Some(parent),
                customer,
                &measured,
            )
            .await?;
        seeder
            .document(
                case,
                "measurement",
                "31",
                FILE_TITLE,
                document(&title, FILE_TITLE, &title, &measured, date),
                status != "draft",
                Some(source),
                None,
                None,
            )
            .await?;
    }
    sqlx::query("INSERT INTO development_seed_manifests(name,seed) VALUES($1,$2)")
        .bind(MANIFEST)
        .bind(replay_seed.to_string())
        .execute(connection)
        .await?;
    Ok(())
}

// Repair only untouched development examples. Retain the original revision and
// object so fixed documents and their source references keep their history.
async fn repair_seed_locations(
    state: &AppState,
    tenant: &str,
    connection: &mut PgConnection,
) -> SeedResult<()> {
    let done: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM development_seed_manifests WHERE name=$1)")
            .bind(LOCATION_MANIFEST)
            .fetch_one(&mut *connection)
            .await?;
    if done {
        return Ok(());
    }
    #[derive(sqlx::FromRow)]
    struct Example {
        id: i64,
        case_id: i64,
        object_key: String,
        file_name: String,
        read_only: bool,
    }
    let examples:Vec<Example>=sqlx::query_as("SELECT d.id,d.case_id,d.object_key,d.file_name,d.read_only FROM commercial_documents d JOIN commercial_cases c ON c.id=d.case_id JOIN users u ON u.id=c.created_by_user_id WHERE c.kind='measurement' AND d.phase='31' AND d.version=1 AND u.username='john.doe' AND c.created_at < d.created_at-INTERVAL '20 days' FOR UPDATE OF d")
        .fetch_all(&mut *connection).await?;
    if !examples.is_empty() {
        let storage = xml_documents::required_storage(state, tenant).await?;
        for example in examples {
            let xml = xml_documents::download_xml_object(
                &storage,
                &example.object_key,
                &example.file_name,
            )
            .await?;
            let Some(updated) = clean_seed_locations(&xml)? else {
                continue;
            };
            let key = object_storage::build_commercial_object_key(
                &storage,
                Id(example.case_id),
                &example.file_name,
            );
            xml_documents::upload_xml(&storage, &key, &updated).await?;
            sqlx::query("INSERT INTO commercial_document_snapshots(document_id,version,object_key,event) VALUES($1,1,$2,'seeded_before_location_cleanup') ON CONFLICT(document_id,version) DO NOTHING")
                .bind(example.id).bind(&example.object_key).execute(&mut *connection).await?;
            sqlx::query("UPDATE commercial_documents SET object_key=$2,size_bytes=$3,version=2,modified_at=NOW() WHERE id=$1")
                .bind(example.id).bind(&key).bind(updated.len() as i64).execute(&mut *connection).await?;
            if example.read_only {
                sqlx::query("INSERT INTO commercial_document_snapshots(document_id,version,object_key,event) VALUES($1,2,$2,'seeded_location_cleanup')")
                    .bind(example.id).bind(&key).execute(&mut *connection).await?;
            }
        }
    }
    sqlx::query(
        "INSERT INTO development_seed_manifests(name,seed) VALUES($1,'location-separators-v2')",
    )
    .bind(LOCATION_MANIFEST)
    .execute(connection)
    .await?;
    Ok(())
}

fn clean_seed_locations(xml: &str) -> SeedResult<Option<String>> {
    let parsed = roxmltree::Document::parse(xml)?;
    if !parsed
        .descendants()
        .any(|node| node.tag_name().name() == "ProgName" && node.text() == Some("sortsys Demo"))
    {
        return Ok(None);
    }
    let mut patches = Vec::new();
    for comment in parsed.descendants().filter(|node| node.is_comment()) {
        let Some(raw) = comment
            .text()
            .and_then(|text| text.strip_prefix("sortsys:measure:v1:"))
        else {
            continue;
        };
        let decoded = percent_encoding::percent_decode_str(raw).decode_utf8()?;
        let mut value: serde_json::Value = serde_json::from_str(&decoded)?;
        let Some(location) = value["location"].as_str() else {
            continue;
        };
        if !location.contains(" · ") {
            continue;
        }
        value["location"] = json!(location.replace(" · ", ", "));
        patches.push((
            comment.range(),
            format!(
                "<!--sortsys:measure:v1:{}-->",
                encode(&serde_json::to_string(&value)?)
            ),
        ));
    }
    if patches.is_empty() {
        return Ok(None);
    }
    let mut result = xml.to_owned();
    for (range, text) in patches.into_iter().rev() {
        result.replace_range(range, &text);
    }
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approaches_are_reproducible_cover_units_and_sum_before_rounding() {
        let source = positions(&mut SeedRng::new(42), 1);
        let a = prepare(&source, &mut SeedRng::new(42));
        let b = prepare(&source, &mut SeedRng::new(42));
        let date = NaiveDate::from_ymd_opt(2026, 11, 6).unwrap();
        let xml = document("Musterprojekt", "Aufmaß November", "Auftrags-LV", &a, date);
        assert!(
            a.iter()
                .flat_map(|position| &position.measures)
                .all(|row| !row.location.contains('·'))
        );
        assert_eq!(
            xml,
            document("Musterprojekt", "Aufmaß November", "Auftrags-LV", &b, date)
        );
        for unit in ["m²", "m", "m³", "Stk", "psch"] {
            assert!(a.iter().any(|p| p.unit == unit));
        }
        assert!(a.iter().all(|p| p.qty > 0
            && !p.measures.is_empty()
            && p.qty == round_quantity(p.measures.iter().map(Measure::result).sum())));
        let parsed = roxmltree::Document::parse(&xml).unwrap();
        let rows = parsed
            .descendants()
            .filter(|node| node.tag_name().name() == "QTakeoff")
            .map(|node| node.attribute("Row").unwrap())
            .collect::<Vec<_>>();
        assert!(rows.len() > 20);
        assert!(rows.iter().all(|row| row.chars().count() == 80));
        let addresses = rows
            .iter()
            .map(|row| row.chars().skip(69).take(6).collect::<String>())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(addresses.len(), rows.len());
        let boundary = Measure::new("area", "Grenze", "EG")
            .dimensions(1250, 2000, 0, 4000)
            .opening("2.5");
        assert!(boundary.overmeasured());
        assert_eq!(boundary.result(), 0);
        let large = Measure::new("area", "Groß", "EG")
            .dimensions(1251, 2000, 0, 4000)
            .opening("2.5");
        assert!(!large.overmeasured());
        assert!(large.result() < 0);
        assert_eq!(round_quantity(62_500_000_000 + 62_500_000_000), 125);
        assert_ne!(
            xml,
            document(
                "Musterprojekt",
                "Aufmaß November",
                "Auftrags-LV",
                &prepare(&source, &mut SeedRng::new(99)),
                date
            )
        );
    }

    #[test]
    fn legacy_seed_location_cleanup_preserves_quantities_and_other_fields() {
        let source = positions(&mut SeedRng::new(42), 1);
        let mut measured = prepare(&source, &mut SeedRng::new(42));
        measured[0].measures[0].location = "EG · Raum 101".to_owned();
        let xml = document(
            "Musterprojekt",
            "Aufmaß",
            "Auftrag",
            &measured,
            NaiveDate::from_ymd_opt(2026, 11, 6).unwrap(),
        );
        let updated = clean_seed_locations(&xml).unwrap().unwrap();
        let parsed = roxmltree::Document::parse(&updated).unwrap();
        let comment = parsed
            .descendants()
            .filter(|node| node.is_comment())
            .find_map(|node| {
                node.text()
                    .and_then(|text| text.strip_prefix("sortsys:measure:v1:"))
            })
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(
            &percent_encoding::percent_decode_str(comment)
                .decode_utf8()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["location"], "EG, Raum 101");
        assert_eq!(value["a"], measured[0].measures[0].a);
        assert!(clean_seed_locations(&updated).unwrap().is_none());
        assert!(
            clean_seed_locations(&xml.replace("sortsys Demo", "Other software"))
                .unwrap()
                .is_none()
        );
    }
}
