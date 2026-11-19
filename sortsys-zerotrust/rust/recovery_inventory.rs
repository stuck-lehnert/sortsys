//! Capacity accounting for a complete recoverable key inventory.
//! The storage adapter must compare and publish the counter with the key records.
use crate::{Result, crypto::invalid};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryLimits {
    pub domains: u32,
    pub key_generations: u32,
}

pub const DEFAULT_RECOVERY_LIMITS: RecoveryLimits = RecoveryLimits {
    domains: 2_000,
    key_generations: 50_000,
};
pub const RECOVERY_INVENTORY_PAGE_ITEMS: usize = 256;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryInventory {
    pub domains: u32,
    pub key_generations: u32,
}

impl RecoveryInventory {
    pub fn validate(self, limits: RecoveryLimits) -> Result<Self> {
        if self.domains > limits.domains
            || self.key_generations < self.domains
            || self.key_generations > limits.key_generations
        {
            return Err(invalid());
        }
        Ok(self)
    }

    fn add(self, addition: Self, limits: RecoveryLimits) -> Result<Self> {
        self.validate(limits)?;
        addition.validate(limits)?;
        Self {
            domains: self
                .domains
                .checked_add(addition.domains)
                .ok_or_else(invalid)?,
            key_generations: self
                .key_generations
                .checked_add(addition.key_generations)
                .ok_or_else(invalid)?,
        }
        .validate(limits)
    }

    /// Leave capacity for a subsequent tenant-wide key rotation as well.
    pub fn reserve(self, addition: Self, limits: RecoveryLimits) -> Result<Self> {
        let next = self.add(addition, limits)?;
        if next
            .key_generations
            .checked_add(next.domains)
            .ok_or_else(invalid)?
            > limits.key_generations
        {
            return Err(invalid());
        }
        Ok(next)
    }

    /// Recovery can use the space reserved by ordinary key publication.
    pub fn rotate(self, limits: RecoveryLimits) -> Result<Self> {
        self.add(
            Self {
                domains: 0,
                key_generations: self.domains,
            },
            limits,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Fixture {
        limits: RecoveryLimits,
        cases: Vec<Case>,
        rotations: Vec<Rotation>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        current: RecoveryInventory,
        addition: RecoveryInventory,
        expected: Option<RecoveryInventory>,
    }

    #[derive(Deserialize)]
    struct Rotation {
        name: String,
        current: RecoveryInventory,
        expected: Option<RecoveryInventory>,
    }

    #[test]
    fn browser_and_server_use_the_same_capacity_vectors() {
        let fixture: Fixture =
            serde_json::from_str(include_str!("../test/fixtures/recovery-inventory.json")).unwrap();
        assert_eq!(fixture.limits, DEFAULT_RECOVERY_LIMITS);
        for case in fixture.cases {
            let actual = case.current.reserve(case.addition, fixture.limits).ok();
            assert_eq!(actual, case.expected, "{}", case.name);
        }
        for case in fixture.rotations {
            let actual = case.current.rotate(fixture.limits).ok();
            assert_eq!(actual, case.expected, "{}", case.name);
        }
    }

    #[test]
    fn additions_cannot_overflow_the_stored_counter() {
        let limits = RecoveryLimits {
            domains: u32::MAX,
            key_generations: u32::MAX,
        };
        let current = RecoveryInventory {
            domains: 1,
            key_generations: u32::MAX,
        };
        assert!(
            current
                .reserve(
                    RecoveryInventory {
                        domains: 0,
                        key_generations: 1
                    },
                    limits
                )
                .is_err()
        );
        assert!(current.rotate(limits).is_err());
    }
}
