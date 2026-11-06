use super::*;

fn invoice_xml(kind: &str, total: &str, previous: Option<&str>) -> String {
    let (vat, gross) = if total == "1000.00" {
        (
            "190.00",
            if previous.is_some() {
                "1071.00"
            } else {
                "1190.00"
            },
        )
    } else {
        ("19.00", "119.00")
    };
    let prior = previous.map(|number|format!("<InvoiceShare><InvoiceShareType>amount invoices</InvoiceShareType><Total>119.00</Total></InvoiceShare><InvoiceMadeOut><TotalVAT>19.00</TotalVAT><Total>100.00</Total><InvoiceDate>2026-11-06</InvoiceDate><InvoiceType>deduction</InvoiceType><InvoiceNo>{number}</InvoiceNo></InvoiceMadeOut>")).unwrap_or_default();
    let _ = vat;
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA89/3.3"><GAEBInfo><Version>3.3</Version><VersDate>2021-05</VersDate><Date>2026-11-06</Date></GAEBInfo><Invoice><DP>89</DP><BoQ ID="b"><BoQInfo><Name>Auftrag</Name><BoQBkdn><Type>Item</Type><Length>4</Length><Num>Yes</Num></BoQBkdn><Totals><Total>{total}</Total></Totals></BoQInfo><BoQBody><Itemlist><Item ID="i" RNoPart="0001"><BillQty>1.000</BillQty><QU>psch</QU><UP>{total}0</UP><IT>{total}</IT></Item></Itemlist></BoQBody></BoQ><InvoiceHeader><InvoiceNo>ENTWURF</InvoiceNo><InvoiceDate>2026-11-06</InvoiceDate><InvoiceType>{kind}</InvoiceType><SettlementType>periodic</SettlementType><ServiceProvisionStartDate>2026-11-01</ServiceProvisionStartDate><ServiceProvisionEndDate>2026-11-06</ServiceProvisionEndDate></InvoiceHeader><InvoiceCreator><Address><Name1>Muster GmbH</Name1><Street>Beispielweg 12</Street><PCode>06108</PCode><City>Halle</City></Address><TaxNo>DEMO</TaxNo></InvoiceCreator><InvoiceRecipient><Address><Name1>Kunde</Name1><Street>Musterweg 20</Street><PCode>06108</PCode><City>Halle</City></Address></InvoiceRecipient><InvoiceShare><InvoiceShareType>basic amount</InvoiceShareType><Total>{total}</Total></InvoiceShare><InvoiceShare><InvoiceShareType>VAT</InvoiceShareType><Percent>19.00</Percent></InvoiceShare>{prior}<TotalGross>{gross}</TotalGross></Invoice></GAEB>"#
    )
}

#[tokio::test]
async fn invoices_issue_with_unique_numbers_settle_progress_and_record_payments() {
    let Some(environment) = TestEnvironment::from_env() else {
        return;
    };
    let fixture = Fixture::create(&environment).await;
    let rpc = RpcClient::new(environment.api_base_url);
    let login=rpc.mutation("auth.login",json!({"tenant":fixture.tenant,"username":fixture.admin_username,"password":fixture.admin_password}),None).await;
    let token = login["token"].as_str().unwrap();
    let customer = rpc
        .mutation(
            "customers.create",
            json!({"name":"Invoice customer"}),
            Some(token),
        )
        .await;
    let main=rpc.mutation("commercial.cases.create",json!({"kind":"offer","title":"Contract","customerId":customer["id"],"scopeItemIds":[]}),Some(token)).await;
    let inquiry=rpc.mutation("commercial.documents.create",json!({"caseId":main["id"],"purpose":"inquiry","fileName":"Tender.x83","xml":"<GAEB/>","readOnly":true}),Some(token)).await;
    rpc.mutation("commercial.documents.create",json!({"caseId":main["id"],"purpose":"offer","fileName":"Offer.x84","xml":"<GAEB/>","readOnly":false,"netAmount":"1000.00","sourceDocumentId":inquiry["id"],"sourceVersion":1}),Some(token)).await;
    for (from, to) in [("draft", "sent"), ("sent", "accepted")] {
        rpc.mutation(
            "commercial.cases.transition",
            json!({"id":main["id"],"expectedStatus":from,"status":to}),
            Some(token),
        )
        .await;
    }
    let project = rpc
        .mutation(
            "commercial.cases.createProject",
            json!({"id":main["id"]}),
            Some(token),
        )
        .await;
    let create = |kind: &str| json!({"kind":kind,"title":kind,"projectId":project["id"],"parentCaseId":main["id"],"scopeItemIds":[],"vatRate":"19.00"});
    rpc.expect_error(
        "commercial.cases.create",
        Method::POST,
        create("final_invoice"),
        Some(token),
        "BAD_REQUEST",
    )
    .await;
    let progress = rpc
        .mutation(
            "commercial.cases.create",
            create("progress_invoice"),
            Some(token),
        )
        .await;
    let xml = invoice_xml("deduction", "100.00", None).replace(
        "<GAEBInfo>",
        "<v:InvoiceNo xmlns:v=\"urn:vendor\">KEEP</v:InvoiceNo><GAEBInfo>",
    );
    let document=rpc.mutation("commercial.documents.create",json!({"caseId":progress["id"],"purpose":"invoice","fileName":"Abschlag.x89","xml":xml,"readOnly":false,"netAmount":"100.00"}),Some(token)).await;
    rpc.expect_error("commercial.documents.save",Method::POST,json!({"caseId":progress["id"],"id":document["id"],"version":1,"xml":xml.replace("<BillQty>1.000", "<BillQty>2.000"),"netAmount":"100.00"}),Some(token),"BAD_REQUEST").await;
    rpc.mutation(
        "commercial.invoices.issue",
        json!({"id":progress["id"]}),
        Some(token),
    )
    .await;
    let detail = rpc
        .query(
            "commercial.cases.get",
            json!({"id":progress["id"]}),
            Some(token),
        )
        .await;
    let number = detail["invoice"]["invoiceNumber"].as_str().unwrap();
    let issued = rpc
        .query(
            "commercial.documents.get",
            json!({"caseId":progress["id"],"id":document["id"]}),
            Some(token),
        )
        .await;
    let issued_xml = issued["xml"].as_str().unwrap();
    assert!(issued_xml.contains(&format!("<InvoiceNo>{number}</InvoiceNo>")));
    assert!(issued_xml.contains(">KEEP</v:InvoiceNo>"));
    assert_eq!(detail["case"]["status"], "sent");
    assert_eq!(detail["documents"][0]["readOnly"], true);
    rpc.expect_error(
        "commercial.invoices.issue",
        Method::POST,
        json!({"id":progress["id"]}),
        Some(token),
        "CONFLICT",
    )
    .await;
    let today = chrono::Utc::now().date_naive().to_string();
    rpc.mutation(
        "commercial.invoices.recordPayment",
        json!({"id":progress["id"],"amount":"40.00","paidOn":today,"reference":"Teilzahlung"}),
        Some(token),
    )
    .await;
    assert_eq!(
        rpc.query(
            "commercial.cases.get",
            json!({"id":progress["id"]}),
            Some(token)
        )
        .await["case"]["status"],
        "partially_paid"
    );
    rpc.expect_error(
        "commercial.invoices.recordPayment",
        Method::POST,
        json!({"id":progress["id"],"amount":"80.00","paidOn":today,"reference":"Zu viel"}),
        Some(token),
        "BAD_REQUEST",
    )
    .await;
    rpc.mutation(
        "commercial.invoices.recordPayment",
        json!({"id":progress["id"],"amount":"79.00","paidOn":today,"reference":"Rest"}),
        Some(token),
    )
    .await;
    assert_eq!(
        rpc.query(
            "commercial.cases.get",
            json!({"id":progress["id"]}),
            Some(token)
        )
        .await["case"]["status"],
        "paid"
    );
    rpc.expect_error(
        "commercial.cases.create",
        Method::POST,
        create("invoice"),
        Some(token),
        "BAD_REQUEST",
    )
    .await;
    let final_invoice = rpc
        .mutation(
            "commercial.cases.create",
            create("final_invoice"),
            Some(token),
        )
        .await;
    rpc.mutation("commercial.documents.create",json!({"caseId":final_invoice["id"],"purpose":"invoice","fileName":"Schluss.x89","xml":invoice_xml("final account","1000.00",Some(number)),"readOnly":false,"netAmount":"900.00"}),Some(token)).await;
    rpc.mutation(
        "commercial.invoices.issue",
        json!({"id":final_invoice["id"]}),
        Some(token),
    )
    .await;
    let final_detail = rpc
        .query(
            "commercial.cases.get",
            json!({"id":final_invoice["id"]}),
            Some(token),
        )
        .await;
    assert_eq!(final_detail["invoice"]["grossAmount"], "1071.00");
    assert_ne!(final_detail["invoice"]["invoiceNumber"], number);
    rpc.expect_error(
        "commercial.cases.create",
        Method::POST,
        create("progress_invoice"),
        Some(token),
        "CONFLICT",
    )
    .await;
}
