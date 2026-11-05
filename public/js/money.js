export function parseMoney(raw) {
  const s = String(raw).trim().replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s))
    throw new Error("Укажи сумму с точностью до копейки");
  const [r, k = ""] = s.split(".");
  const amount = BigInt(r) * 100n + BigInt(k.padEnd(2, "0"));
  if (amount <= 0n) throw new Error("Сумма должна быть больше нуля");
  return amount.toString();
}
export function formatMoney(raw) {
  const n = BigInt(raw ?? 0);
  const sign = n < 0n ? "−" : "";
  const a = n < 0n ? -n : n;
  return (
    sign +
    (a / 100n).toLocaleString("ru-RU") +
    "," +
    (a % 100n).toString().padStart(2, "0") +
    " К₽"
  );
}
