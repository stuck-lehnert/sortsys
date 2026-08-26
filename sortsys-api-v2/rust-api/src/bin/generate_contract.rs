use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let check = args.next().as_deref() == Some("--check");
    let path = if check {
        args.next()
    } else {
        env::args().nth(1)
    }
    .map(PathBuf::from)
    .unwrap_or_else(|| PathBuf::from("client/src/generated/contract.ts"));
    if args.next().is_some() {
        return Err("usage: generate_contract [--check] [output-path]".into());
    }

    let contract = sortsys_api::api::contract_registry().typescript_contract();
    if check {
        let existing = fs::read_to_string(&path)?;
        if existing != contract {
            return Err(format!("{} is not current", path.display()).into());
        }
    } else {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, contract)?;
        println!("generated {}", path.display());
    }
    Ok(())
}
