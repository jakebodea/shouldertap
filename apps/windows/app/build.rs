//! Marks dev builds (`cargo build` without `--release`), and on Windows embeds
//! the manifest (Per-Monitor V2 DPI, common controls), icon and version info.

use std::path::Path;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(dev_build)");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo::rustc-cfg=dev_build");
    }
    println!("cargo::rerun-if-changed=resources");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
    let version = env!("CARGO_PKG_VERSION");
    let numeric = format!("{},0", version.replace('.', ","));
    // Written out with literal values: llvm-rc (cross-builds) and rc.exe both
    // take it, with no headers to find.
    let rc = format!(
        r#"1 24 "{manifest}"
1 ICON "{icon}"
1 VERSIONINFO
FILEVERSION {numeric}
PRODUCTVERSION {numeric}
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "CompanyName", "Shouldertap"
      VALUE "FileDescription", "Shouldertap"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "Shouldertap"
      VALUE "OriginalFilename", "Shouldertap.exe"
      VALUE "ProductName", "Shouldertap"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#,
        manifest = resources
            .join("shouldertap.manifest")
            .display()
            .to_string()
            .replace('\\', "\\\\"),
        icon = resources
            .join("Shouldertap.ico")
            .display()
            .to_string()
            .replace('\\', "\\\\"),
    );
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("shouldertap.rc");
    std::fs::write(&out, rc).expect("write the resource script");
    embed_resource::compile(&out, embed_resource::NONE)
        .manifest_required()
        .expect("embed the Windows resources");
}
