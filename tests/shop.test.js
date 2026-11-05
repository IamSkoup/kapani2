import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const turn = () => new Promise((r) => setTimeout(r, 0));
test("finishing checkout in another shop preserves the new cart", async () => {
  const dom = new JSDOM('<main></main><div id="status"></div>', {
    url: "https://kapani.test",
  });
  for (const k of ["window", "document", "Node"])
    globalThis[k] = k === "window" ? dom.window : dom.window[k];
  globalThis.confirm = () => true;
  let finish;
  const pending = new Promise((r) => (finish = r)),
    sent = [];
  const businesses = [
    { id: "a", name: "Первый", owner_id: "other" },
    { id: "b", name: "Второй", owner_id: "other" },
  ];
  globalThis.__shopMock = {
    client: {
      from(table) {
        let selected;
        const q = {
          select() {
            return q;
          },
          eq(k, v) {
            if (k === "business_id") selected = v;
            return q;
          },
          order() {
            return q;
          },
          limit() {
            return q;
          },
          then(resolve) {
            return Promise.resolve(
              table === "businesses"
                ? businesses
                : table === "business_products"
                  ? [
                      {
                        id: selected + "-item",
                        title: "Товар " + selected,
                        description: "",
                        price: "100",
                        stock: 10,
                        active: true,
                      },
                    ]
                  : [],
            ).then(resolve);
          },
        };
        return q;
      },
    },
    rpc: async (name, args) => {
      if (name === "checkout_business") {
        sent.push(args);
        await pending;
      }
      return [];
    },
  };
  const out = await build({
    entryPoints: ["public/js/shop.js"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    plugins: [
      {
        name: "mock-api",
        setup(b) {
          b.onResolve({ filter: /\/api\.js$/ }, () => ({
            path: "api",
            namespace: "mock",
          }));
          b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
            contents:
              "export const {client,rpc}=globalThis.__shopMock;export const unwrap=async x=>x;export const friendly=e=>e.message;",
          }));
        },
      },
    ],
  });
  try {
    const { shopPage } = await import(
      "data:text/javascript;base64," +
        Buffer.from(out.outputFiles[0].text).toString("base64")
    );
    await shopPage(document.querySelector("main"), { user: { id: "buyer" } });
    const select = document.querySelector("select");
    const click = (text) =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === text)
        .click();
    select.value = "a";
    await select.onchange();
    click("В корзину");
    await turn();
    click("Подтвердить и зарезервировать оплату");
    await turn();
    assert.equal(sent[0].p_business, "a");
    select.value = "b";
    await select.onchange();
    click("В корзину");
    await turn();
    finish();
    await turn();
    await turn();
    assert.ok(document.body.textContent.includes("Товар b × 1"));
    assert.deepEqual(sent[0].p_items, [{ product_id: "a-item", quantity: 1 }]);
  } finally {
    dom.window.close();
    delete globalThis.__shopMock;
  }
});
