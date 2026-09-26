import { execute } from "../tools/echo.mjs";

const result = await execute({ text: "hi" });
if (result.output.echoed !== "HI") {
  console.error("echo did not upper-case its input");
  process.exit(1);
}
console.log("echo ok");
