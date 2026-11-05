import {readdirSync} from "node:fs";
import {execFileSync} from "node:child_process";
for(const file of readdirSync("public/js").filter(f=>f.endsWith(".js")))execFileSync(process.execPath,["--check","public/js/"+file],{stdio:"inherit"});
execFileSync(process.execPath,["--check","public/sw.js"],{stdio:"inherit"});
console.log("All application modules parsed successfully");
