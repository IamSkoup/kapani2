import { config } from "./config.js";
export let client = null;
export async function initialize() {
  if (!config.publishableKey) return false;
  const { createClient } = await import("../vendor/supabase.js");
  client = createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    global: {
      fetch: async (input, init = {}) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const abort = () => controller.abort(init.signal?.reason);
        if (init.signal?.aborted) abort();
        init.signal?.addEventListener("abort", abort, { once: true });
        try {
          return await fetch(input, {
            ...init,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
          init.signal?.removeEventListener("abort", abort);
        }
      },
    },
  });
  return true;
}
export async function unwrap(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
export const rpc = (name, args) => unwrap(client.rpc(name, args));
export function friendly(error) {
  const s = error?.message ?? String(error);
  const map = {
    "Insufficient funds": "Недостаточно средств",
    "Municipal verification required":
      "Для экономики нужно подтверждение мэрии",
    "Task incomplete": "Условие задания ещё не выполнено",
    "Task unavailable": "Задание недоступно или период завершён",
    "Subscription required": "Нужна действующая подписка",
    "Business unavailable": "Организация недоступна или принадлежит тебе",
    "Stock unavailable": "Товара уже недостаточно. Обнови каталог",
    "Price changed": "Цена изменилась. Обнови каталог перед оплатой",
    "Open dispute after acceptance":
      "После принятия заказа открой спор или свяжись с организацией",
    "Access denied": "Недостаточно прав",
    "Invalid recipient": "Получатель недоступен",
    "Rate limit": "Слишком много запросов. Попробуй немного позже",
    "Slot unavailable": "Это время уже занято или больше недоступно",
    "Event is full": "Все места уже заняты",
    "Registration closed": "Регистрация завершена",
    "Attempt closed": "Время попытки завершилось",
    "Exam attempt limit": "Лимит попыток на сутки исчерпан",
    "Not enough questions": "Сначала добавь нужное количество вопросов",
    "Unsupported file": "Этот тип файла или расширение не поддерживается",
    "File too large": "Размер файла превышает допустимый",
    "File not uploaded":
      "Загрузка файла ещё не завершена или параметры не совпали",
    "Invalid transition": "Это действие недоступно в текущем состоянии",
    "Failed to fetch": "Нет соединения с сервером. Повтори попытку",
    "Invalid login credentials": "Не удалось войти. Проверь данные",
    "Idempotency conflict": "Этот запрос уже использован для другой операции",
  };
  return map[s] ?? s;
}

export async function signIn(identifier, password) {
  const response = await fetch(config.url + "/functions/v1/kapani-login", {
    method: "POST",
    headers: {
      apikey: config.publishableKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ identifier, password }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? "Не удалось войти");
  return unwrap(
    client.auth.setSession({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    }),
  );
}
