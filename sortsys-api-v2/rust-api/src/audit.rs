//! Actor attribution for transactional, database-triggered entity history.

use std::{cell::RefCell, future::Future};

use axum::{extract::Request, middleware::Next, response::Response};
use sqlx::PgConnection;

#[derive(Clone, Default)]
struct Actor {
    user_id: Option<i64>,
    kind: String,
    name: String,
    tenant: String,
}

tokio::task_local! {
    static ACTOR: RefCell<Actor>;
}

pub async fn scope<F: Future>(future: F) -> F::Output {
    ACTOR.scope(RefCell::new(Actor::default()), future).await
}

pub async fn middleware(request: Request, next: Next) -> Response {
    scope(next.run(request)).await
}

pub fn user(tenant: &str, id: i64, name: String) {
    set(Actor {
        user_id: Some(id),
        kind: "user".into(),
        name,
        tenant: tenant.into(),
    });
}

pub fn admin(tenant: &str) {
    set(Actor {
        kind: if tenant == "+all" {
            "globalAdmin"
        } else {
            "tenantAdmin"
        }
        .into(),
        tenant: if tenant == "+all" {
            String::new()
        } else {
            tenant.into()
        },
        ..Actor::default()
    });
}

fn set(actor: Actor) {
    // Background work without a request scope remains explicitly system-owned.
    let _ = ACTOR.try_with(|current| *current.borrow_mut() = actor);
}

pub async fn prepare_connection(connection: &mut PgConnection) -> Result<(), sqlx::Error> {
    let actor = ACTOR
        .try_with(|current| current.borrow().clone())
        .unwrap_or_default();

    // Set all values on every checkout, including anonymous/system work. A pooled
    // connection must never inherit the actor of its previous borrower.
    sqlx::query(
        "SELECT set_config('sortsys.actor_id', $1, false),
                set_config('sortsys.actor_kind', $2, false),
                set_config('sortsys.actor_name', $3, false),
                set_config('sortsys.actor_tenant', $4, false)",
    )
    .bind(actor.user_id.map(|id| id.to_string()).unwrap_or_default())
    .bind(if actor.kind.is_empty() {
        "system"
    } else {
        &actor.kind
    })
    .bind(actor.name)
    .bind(actor.tenant)
    .execute(connection)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn concurrent_scopes_do_not_share_actors() {
        let actors = futures_util::future::join_all((1..20).map(|id| {
            scope(async move {
                user("test", id, format!("User {id}"));
                tokio::task::yield_now().await;
                ACTOR.with(|actor| actor.borrow().user_id)
            })
        }))
        .await;
        assert_eq!(actors, (1..20).map(Some).collect::<Vec<_>>());
        assert!(ACTOR.try_with(|_| ()).is_err());
    }
}
