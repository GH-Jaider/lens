use std::process::Command;

fn main() {
    // The pages are TypeScript; the binary embeds what this builds.
    println!("cargo:rerun-if-changed=web/src");
    println!("cargo:rerun-if-changed=scripts/web.ts");
    let built = Command::new("node").arg("scripts/web.ts").status();
    match built {
        Ok(status) if status.success() => {}
        Ok(_) => panic!("The pages did not build. Run `pnpm install` first if you have not."),
        Err(error) => panic!("Node is needed to build the pages: {error}"),
    }
    tauri_build::build()
}
