use sortsys_dwg_parser::from_bytes;

#[test]
fn committed_development_plans_contain_renderable_geometry() {
    for bytes in [
        include_bytes!("../../../sortsys-api-v2/seed-assets/grundriss-erdgeschoss.dwg").as_slice(),
        include_bytes!("../../../sortsys-api-v2/seed-assets/grundriss-obergeschoss.dwg").as_slice(),
    ] {
        let document = from_bytes(bytes);
        assert!(document.items.len() >= 15, "{document:?}");
        assert!(!document.pages.is_empty());
        assert!(
            document
                .items
                .iter()
                .any(|item| item.id.starts_with("LINE-"))
        );
    }
}
