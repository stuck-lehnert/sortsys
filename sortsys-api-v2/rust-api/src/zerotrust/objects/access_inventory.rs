//! Bounded public inventories. Cursors select records; each page independently
//! authenticates its session and verifies permissions in the read transaction.
use super::*;
use crate::zerotrust::{
    access::{MetadataContext, MetadataRequest, inherited_rules, metadata_context_for_domains},
    creation::{CreationOrigin, visible_origins},
};

// Public access metadata is small compared with encrypted object pages. A
// bounded larger page avoids a round trip for each handful of project facets.
const PAGE_SIZE: usize = 128;

async fn inventory_page(
    service: &crate::auth::AuthService,
    request: &RequestContext,
    after: Option<String>,
    include_domains: bool,
) -> RpcResult<(MetadataContext, Vec<String>, Option<String>)> {
    let mut request = MetadataRequest::open(service, request).await?;
    if !include_domains {
        // Menus derive permissions from creation proofs. Authority-created
        // areas are already covered by the signed policy and need no listing.
        let mut context = request.authorize_origins(&[]).await?;
        let collection = registry::origin_collection(context.security.root.generation);
        let page = context
            .transaction
            .scan_with_limit::<CreationOrigin>(
                &collection,
                after,
                sortsys_store::metadata::MAX_SCAN_PAGE,
            )
            .await?;
        let mut origins = Vec::with_capacity(page.records.len());
        for row in page.records {
            let origin = row.value.ok_or_else(invalid)?;
            if origin.id != row.record.key {
                return Err(invalid());
            }
            identifier(&origin.id)?;
            origins.push(origin);
        }
        let security = &mut context.security;
        security.origins = visible_origins(
            origins,
            &context.auth,
            security.root.generation,
            &security.authority,
            &security.subject,
            &security.policy,
        )?;
        security.inherited = inherited_rules(&security.origins, &security.policy);
        return Ok((context, Vec::new(), page.after));
    }
    let page = request
        .transaction
        .scan_with_limit::<DomainDescriptor>("domain-catalog", after, PAGE_SIZE)
        .await?;
    let mut descriptors = Vec::new();
    for row in page.records {
        let descriptor = row.value.ok_or_else(invalid)?;
        if descriptor.id != row.record.key {
            return Err(invalid());
        }
        identifier(&descriptor.id)?;
        descriptors.push(descriptor);
    }
    let domains: Vec<String> = descriptors.iter().map(|area| area.id.clone()).collect();
    let mut context = request.authorize(Some(&domains)).await?;
    for descriptor in descriptors {
        let area = registry::retained_domain(&mut context.transaction, &descriptor.id).await?;
        if area.scope != descriptor.scope || area.facet != descriptor.facet {
            return Err(invalid());
        }
    }
    Ok((context, domains, page.after))
}

/// Content revisions deliberately do not enter this identity. An autosave may
/// change an area's sequence while its public access inventory stays unchanged.
/// Registration, rotation and grants that change the rotation state advance
/// the root's catalogue version.
async fn snapshot(
    context: &mut MetadataContext,
    include_domains: bool,
    selected: Option<&[String]>,
) -> RpcResult<String> {
    let root =
        super::super::setup::metadata_root(&mut context.transaction, &context.auth.tenant).await?;
    let mut roles = context.auth.roles.clone();
    roles.sort();
    let source_version = if include_domains {
        root.catalog_version.clone()
    } else {
        context
            .transaction
            .collection_version(&registry::origin_collection(
                context.security.root.generation,
            ))
            .await?
    };
    let content = context
        .transaction
        .content_epoch()
        .await?
        .map(|head| head.fingerprint())
        .transpose()?;
    let identity = serde_json::to_string(&(
        "sortsys/access-inventory/v1",
        &context.auth.tenant,
        &context.auth.session.id,
        &context.auth.user.username,
        &context.security.subject,
        roles,
        &context.security.signing_key,
        &root.profile.authority.signature,
        &context.security.policy.signature,
        source_version,
        content,
        include_domains,
        selected,
    ))
    .map_err(|_| invalid())?;
    Ok(crate::control::fingerprint(&identity))
}

/// Bind commands that depend on a complete inventory, including areas created
/// since the browser read it. The root read joins the command's CAS checks.
pub(in crate::zerotrust) async fn check_snapshot(
    context: &mut MetadataContext,
    expected: &str,
) -> RpcResult<()> {
    sized::<32>(expected)?;
    if snapshot(context, true, None).await? != expected {
        return Err(conflict());
    }
    Ok(())
}

pub(super) async fn first(
    service: &crate::auth::AuthService,
    request: &RequestContext,
    mut input: AccessInput,
) -> RpcResult<AccessSnapshot> {
    let pages = input.pages.take();
    let selected = input.selected_domains()?;
    let include_domains = input.include_domains.unwrap_or(true);
    let requested_page_domains = if let Some(pages) = &pages {
        let fresh_selection = selected.is_some() && input.known.is_none();
        let known_inventory = selected.is_none() && input.known.is_some();
        if !include_domains || !(fresh_selection || known_inventory) {
            return Err(invalid());
        }
        let page_domains = persistence::selected_domains(pages)?;
        if selected
            .is_some_and(|domains| page_domains.iter().any(|domain| !domains.contains(domain)))
        {
            return Err(invalid());
        }
        page_domains
    } else {
        Vec::new()
    };
    if let Some(known) = &input.known {
        sized::<32>(known)?;
        let mut context =
            metadata_context_for_domains(service, request, Some(&requested_page_domains)).await?;
        let snapshot = snapshot(&mut context, include_domains, selected).await?;
        if known == &snapshot {
            let pages = match pages {
                Some(pages) => Some(persistence::selected_pages(&mut context, pages).await?),
                None => None,
            };
            let history = super::super::setup::metadata_history(&mut context.transaction).await?;
            context.transaction.validate().await?;
            return Ok(AccessSnapshot {
                subject: context.security.subject,
                username: context.auth.user.username,
                history,
                policy: context.security.policy,
                origins: Vec::new(),
                domains: Vec::new(),
                snapshot,
                after: None,
                unchanged: true,
                pages,
            });
        }
    }
    let (mut context, domains, after) = if let Some(domains) = selected {
        (
            metadata_context_for_domains(service, request, Some(domains)).await?,
            domains.to_vec(),
            None,
        )
    } else {
        inventory_page(service, request, None, include_domains).await?
    };
    if let Some(id) = &input.domain {
        let area = registry::domain(&mut context.transaction, id).await?;
        if !context.auth.is_admin()
            && !context.security.allows(
                &context.security.subject,
                &area.scope,
                area.facet,
                Action::Read,
            )
        {
            return Err(forbidden());
        }
    }
    let snapshot = snapshot(&mut context, include_domains, selected).await?;
    let history = super::super::setup::metadata_history(&mut context.transaction).await?;
    let domains = page_domains(&mut context, include_domains, &domains).await?;
    // Discard warm page requests if the complete inventory changed. The
    // browser must choose pages again using the newly verified catalogue.
    let pages = match (selected, pages) {
        (Some(_), Some(pages)) => Some(persistence::selected_pages(&mut context, pages).await?),
        _ => None,
    };
    context.transaction.validate().await?;
    Ok(AccessSnapshot {
        subject: context.security.subject,
        username: context.auth.user.username,
        history,
        policy: context.security.policy,
        origins: context.security.origins,
        domains,
        snapshot,
        after,
        unchanged: false,
        pages,
    })
}

async fn page_domains(
    context: &mut MetadataContext,
    include_domains: bool,
    domains: &[String],
) -> RpcResult<Vec<DomainInfo>> {
    if !include_domains {
        return Ok(Vec::new());
    }
    // The page's origins may be empty or omit areas created by an authority.
    // Catalogue keys, rather than visible origins, define the page boundary.
    registry::list_domains(context, Some(domains)).await
}

pub(super) async fn next(
    service: &crate::auth::AuthService,
    request: &RequestContext,
    input: AccessPageInput,
) -> RpcResult<AccessInventoryPage> {
    sized::<32>(&input.snapshot)?;
    identifier(&input.after)?;
    let (mut context, domains, after) =
        inventory_page(service, request, Some(input.after), input.include_domains).await?;
    let snapshot = snapshot(&mut context, input.include_domains, None).await?;
    if snapshot != input.snapshot {
        return Err(crate::control::conflict());
    }
    let domains = page_domains(&mut context, input.include_domains, &domains).await?;
    context.transaction.validate().await?;
    Ok(AccessInventoryPage {
        snapshot,
        origins: context.security.origins,
        domains,
        after,
    })
}
