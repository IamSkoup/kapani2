import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const turn = () => new Promise((r) => setTimeout(r, 0));

test("switching rooms during upload preserves the original message and the new draft", async () => {
  const dom = new JSDOM('<main></main><div id="status"></div>', {
    url: "https://kapani.test/",
  });
  for (const key of ["window", "document", "Node", "sessionStorage"])
    globalThis[key] = key === "window" ? dom.window : dom.window[key];
  globalThis.innerHeight = 800;
  const upload = deferred(),
    removal = deferred(),
    sent = [];
  let deferRemoval = false;
  const rooms = [
    { id: "room-a", title: "Первый" },
    { id: "room-b", title: "Второй" },
    { id: "room-c", title: "Третий" },
  ];
  globalThis.__chatMock = {
    rpc: async (name, args) => {
      if (name === "conversation_list") return rooms;
      if (name === "message_history") return [];
      if (name === "send_message_media") {
        sent.push(args);
        return args.p_id;
      }
      return null;
    },
    client: {
      removeChannel: () => (deferRemoval ? removal.promise : Promise.resolve()),
      channel: () => ({
        on() {
          return this;
        },
        subscribe() {
          return this;
        },
      }),
    },
    uploadFile: async () => {
      await upload.promise;
      return { id: "upload-a" };
    },
  };
  const output = await build({
    entryPoints: ["public/js/messenger.js"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    plugins: [
      {
        name: "test-boundaries",
        setup(b) {
          b.onResolve({ filter: /\/api\.js$/ }, () => ({
            path: "api",
            namespace: "mock",
          }));
          b.onResolve({ filter: /\/uploads\.js$/ }, () => ({
            path: "uploads",
            namespace: "mock",
          }));
          b.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
            contents:
              path === "api"
                ? "export const {client,rpc}=globalThis.__chatMock;export const unwrap=async x=>x;export const friendly=e=>e.message;"
                : 'export const {uploadFile}=globalThis.__chatMock;export const prepareFiles=fs=>fs.map(file=>({id:"upload-a",file}));export const attachmentView=()=>document.createElement("span");',
          }));
        },
      },
    ],
  });
  const { messenger } = await import(
    "data:text/javascript;base64," +
      Buffer.from(output.outputFiles[0].text).toString("base64")
  );
  const cleanup = await messenger(document.querySelector("main"), {
    user: { id: "alice" },
  });
  try {
    const oldInput = document.querySelector(".composer textarea");
    oldInput.value = "Текст первого чата";
    oldInput.dispatchEvent(new dom.window.Event("input"));
    const file = document.querySelector("input[type=file]");
    Object.defineProperty(file, "files", {
      value: [
        new dom.window.File(["hello"], "note.txt", { type: "text/plain" }),
      ],
    });
    file.dispatchEvent(new dom.window.Event("change"));
    const sending = document
      .querySelector(".composer")
      .onsubmit({ preventDefault() {} });
    await turn();
    const clickRoom = (title) =>
      [...document.querySelectorAll(".chat-list button")]
        .find((b) => b.querySelector("strong")?.textContent === title)
        .click();
    clickRoom("Второй");
    await turn();
    await turn();
    const newInput = document.querySelector(".composer textarea");
    newInput.value = "Черновик второго чата";
    newInput.dispatchEvent(new dom.window.Event("input"));
    upload.resolve();
    await sending;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].p_conversation, "room-a");
    assert.equal(sent[0].p_body, "Текст первого чата");
    assert.deepEqual(sent[0].p_uploads, ["upload-a"]);
    assert.equal(newInput.value, "Черновик второго чата");
    assert.equal(
      sessionStorage.getItem("kapani-draft-alice-room-b"),
      "Черновик второго чата",
    );
    assert.equal(sessionStorage.getItem("kapani-draft-alice-room-a"), null);
    // An older slow unsubscribe must never reopen a room after a newer click.
    deferRemoval = true;
    clickRoom("Первый");
    await turn();
    clickRoom("Третий");
    await turn();
    removal.resolve();
    await turn();
    await turn();
    assert.equal(document.querySelector(".chat-room h2").textContent, "Третий");
  } finally {
    cleanup();
    dom.window.close();
    delete globalThis.__chatMock;
  }
});
