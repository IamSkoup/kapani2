import { client, unwrap, rpc, friendly } from "./api.js";
import { config } from "./config.js";
import { el, card, field, busy, toast, empty } from "./ui.js";
import { formatMoney } from "./money.js";
const labels = {
  searching: "Ищем водителя",
  offered: "Ожидаем ответ водителя",
  accepted: "Водитель найден",
  arriving: "Водитель едет к тебе",
  waiting: "Водитель ожидает",
  in_progress: "Поездка",
  completed: "Завершена",
  cancelled: "Отменена",
};
const act = (title, fn) =>
  el(
    "button",
    {
      type: "button",
      class: "quiet",
      onClick: async (e) => {
        try {
          await busy(e.currentTarget, fn);
        } catch (error) {
          toast(friendly(error));
        }
      },
    },
    title,
  );
export async function taxiPage(app, session) {
  let disposed = false,
    poll = null,
    watch = null,
    lastLocation = 0,
    loading = false,
    routeMap = null;
  const roles = await unwrap(
    client.from("user_roles").select("role").eq("user_id", session.user.id),
  );
  const driver = roles.some((r) => r.role === "driver");
  const form = el("form", { class: "card" }, el("h2", {}, "Куда поедем?"));
  const values = {};
  for (const [key, label] of Object.entries({
    pickup_lat: "Откуда — широта",
    pickup_lng: "Откуда — долгота",
    dropoff_lat: "Куда — широта",
    dropoff_lng: "Куда — долгота",
  })) {
    const f = field(form, label, key, "number");
    f.step = "any";
    f.min = key.endsWith("lat") ? "-85" : "-180";
    f.max = key.endsWith("lat") ? "85" : "180";
    values[key] = f;
  }
  const calculate = el("button", { type: "submit" }, "Рассчитать по дорогам");
  calculate.disabled = !config.routingConfigured;
  form.append(calculate);
  const quote = el("section", { class: "section" }),
    rides = el("section", { class: "section" }),
    driverArea = el("section", { class: "section" });
  app.append(
    el("h1", {}, "Такси Капани"),
    el(
      "p",
      {},
      "Цена рассчитывается по дорожному маршруту до подтверждения. При поиске дольше 10 минут резерв возвращается. До начала поездки отмена бесплатная; после начала требуется обращение в поддержку.",
    ),
    ...(config.routingConfigured
      ? []
      : [
          el(
            "p",
            { class: "notice" },
            "Расчёт дорожных маршрутов пока не подключён. Оформление поездки недоступно до подключения провайдера.",
          ),
        ]),
    form,
    quote,
    driverArea,
    rides,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(calculate, async () => {
        const { session: current } = await unwrap(client.auth.getSession());
        if (!current) throw Error("Войди в аккаунт");
        const response = await fetch(
          config.url + "/functions/v1/kapani-route",
          {
            method: "POST",
            headers: {
              apikey: config.publishableKey,
              Authorization: "Bearer " + current.access_token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(
              Object.fromEntries(
                Object.entries(values).map(([k, v]) => [k, Number(v.value)]),
              ),
            ),
            signal: AbortSignal.timeout(30000),
          },
        );
        const q = await response.json();
        if (!response.ok) throw Error(q.error ?? "Маршрут недоступен");
        if (disposed) return;
        routeMap?.remove();
        routeMap = null;
        quote.replaceChildren(
          card(
            el("h2", {}, formatMoney(q.amount)),
            el(
              "p",
              {},
              `${(q.distance_m / 1000).toFixed(1)} км · примерно ${Math.ceil(q.duration_s / 60)} мин.`,
            ),
            el(
              "p",
              { class: "small" },
              "Расчёт действует до " +
                new Date(q.expires_at).toLocaleTimeString("ru-RU"),
            ),
            act("Подтвердить заказ", async () => {
              if (
                !confirm(
                  "Зарезервировать " + formatMoney(q.amount) + " на поездку?",
                )
              )
                return;
              await rpc("request_taxi", { p_quote: q.id });
              quote.replaceChildren();
              routeMap?.remove();
              routeMap = null;
              await refresh();
            }),
          ),
        );
        await import("../vendor/leaflet/leaflet.js");
        if (disposed) return;
        const host = el("div", { class: "village-map" });
        quote.append(host);
        const L = window.L;
        routeMap = L.map(host, { zoomControl: false });
        L.control
          .zoom({ zoomInTitle: "Приблизить", zoomOutTitle: "Отдалить" })
          .addTo(routeMap);
        if (config.mapTiles)
          L.tileLayer(config.mapTiles, {
            attribution: config.mapAttribution,
            maxZoom: 19,
          }).addTo(routeMap);
        else
          host.before(
            el(
              "p",
              { class: "notice" },
              "Фоновая карта не подключена. Линия показывает только маршрут, полученный от дорожного провайдера.",
            ),
          );
        const line = L.geoJSON(q.geometry, {
          style: { color: "#b8dfa4", weight: 5 },
        }).addTo(routeMap);
        routeMap.fitBounds(line.getBounds(), { padding: [25, 25] });
      });
    } catch (error) {
      toast(friendly(error));
    }
  };
  function stopLocation() {
    if (watch !== null) {
      navigator.geolocation.clearWatch(watch);
      watch = null;
    }
  }
  if (driver) {
    const records = await unwrap(
      client.from("taxi_drivers").select("*").eq("user_id", session.user.id),
    );
    const current = records[0];
    const f = el(
        "form",
        { class: "card" },
        el("h2", {}, "Рабочее место водителя"),
      ),
      vehicle = field(
        f,
        "Автомобиль",
        "vehicle",
        "text",
        current?.vehicle ?? "",
      ),
      plate = field(
        f,
        "Номер или обозначение транспорта",
        "plate",
        "text",
        current?.plate ?? "",
      ),
      online = el("input", { type: "checkbox" }),
      share = el("input", { type: "checkbox" }),
      save = el("button", { type: "submit" }, "Сохранить состояние");
    online.checked = current?.online ?? false;
    share.checked = current?.share_location ?? false;
    const locationStatus = el("p", { "aria-live": "polite", class: "small" });
    f.append(
      el("label", {}, online, " На линии"),
      el(
        "label",
        {},
        share,
        " Разрешить передачу координат пассажиру во время заказа",
      ),
      save,
      locationStatus,
      act("Начать передачу геолокации", async () => {
        if (!share.checked)
          throw Error("Сначала включи согласие на передачу координат");
        if (!navigator.geolocation) throw Error("Геолокация недоступна");
        await rpc("set_taxi_driver", {
          p_vehicle: vehicle.value,
          p_plate: plate.value,
          p_online: online.checked,
          p_share: true,
        });
        stopLocation();
        watch = navigator.geolocation.watchPosition(
          async (position) => {
            if (disposed || Date.now() - lastLocation < 10000) return;
            lastLocation = Date.now();
            try {
              await rpc("update_taxi_location", {
                p_lat: position.coords.latitude,
                p_lng: position.coords.longitude,
              });
              locationStatus.textContent =
                "Координаты переданы в " +
                new Date().toLocaleTimeString("ru-RU");
            } catch (error) {
              stopLocation();
              locationStatus.textContent = friendly(error);
            }
          },
          () => {
            stopLocation();
            locationStatus.textContent =
              "Нет доступа к геолокации. Координаты не передаются.";
          },
          { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
        );
      }),
      act("Остановить передачу", async () => {
        stopLocation();
        share.checked = false;
        await rpc("set_taxi_driver", {
          p_vehicle: vehicle.value,
          p_plate: plate.value,
          p_online: online.checked,
          p_share: false,
        });
        locationStatus.textContent = "Передача остановлена";
      }),
    );
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await busy(save, () =>
          rpc("set_taxi_driver", {
            p_vehicle: vehicle.value,
            p_plate: plate.value,
            p_online: online.checked,
            p_share: share.checked,
          }),
        );
        if (!share.checked) stopLocation();
        await refresh();
      } catch (error) {
        toast(friendly(error));
      }
    };
    driverArea.append(f);
  }
  const offers = el("section", { class: "section" });
  driverArea.append(offers);
  async function change(r, next) {
    if (next === "cancel" && !confirm("Отменить поездку с возвратом резерва?"))
      return;
    await rpc("taxi_action", {
      p_ride: r.id,
      p_action: next,
      p_reason: next === "cancel" ? "Отмена участником поездки" : "",
    });
    await refresh();
  }
  async function refresh() {
    if (disposed || loading) return;
    loading = true;
    try {
      const data = await unwrap(
        client
          .from("taxi_rides")
          .select("*,taxi_quotes(*)")
          .order("created_at", { ascending: false })
          .limit(30),
      );
      if (disposed) return;
      if (
        !data.some(
          (r) =>
            r.driver_id === session.user.id &&
            !["completed", "cancelled"].includes(r.status),
        )
      )
        stopLocation();
      rides.replaceChildren(el("h2", {}, "Поездки"), act("Обновить", refresh));
      for (const r of data) {
        const mine = r.passenger_id === session.user.id,
          assigned = r.driver_id === session.user.id,
          q = r.taxi_quotes;
        const node = card(
          el("h3", {}, labels[r.status]),
          el("p", {}, formatMoney(q.amount)),
          el(
            "p",
            { class: "small" },
            `${q.pickup_lat}, ${q.pickup_lng} → ${q.dropoff_lat}, ${q.dropoff_lng}`,
          ),
        );
        if (assigned || (driver && !mine && r.status === "offered")) {
          node.append(
            el(
              "p",
              {},
              "Вознаграждение " +
                formatMoney(BigInt(q.amount) - BigInt(q.commission)),
            ),
          );
          const next = {
            accepted: "arriving",
            arriving: "waiting",
            waiting: "in_progress",
            in_progress: "completed",
          }[r.status];
          if (next)
            node.append(
              act(
                {
                  arriving: "Еду к пассажиру",
                  waiting: "Прибыл, ожидаю",
                  in_progress: "Начать поездку",
                  completed: "Завершить поездку",
                }[next],
                () => change(r, next),
              ),
            );
        }
        if (
          (mine || assigned) &&
          !["completed", "cancelled", "in_progress"].includes(r.status)
        )
          node.append(act("Отменить", () => change(r, "cancel")));
        if ((mine || assigned) && r.driver_id) {
          const info = await rpc("taxi_driver_info", { p_ride: r.id });
          if (disposed) return;
          if (info[0]) {
            const d = info[0];
            node.append(
              el("p", {}, `${d.display_name} · ${d.vehicle} · ${d.plate}`),
              el(
                "p",
                { class: "small" },
                d.latitude !== null
                  ? `Местоположение ${d.latitude}, ${d.longitude}. Обновлено ${new Date(d.location_at).toLocaleTimeString("ru-RU")}`
                  : "Актуальные координаты не передаются",
              ),
            );
          }
        }
        node.append(el("a", { href: "#civic" }, "Обратиться в поддержку"));
        rides.append(node);
      }
      if (!data.length) rides.append(empty("Поездок пока нет"));
      if (driver) {
        const rows = await unwrap(
          client
            .from("taxi_offers")
            .select("*")
            .eq("driver_id", session.user.id)
            .eq("status", "pending")
            .gt("expires_at", new Date().toISOString())
            .limit(10),
        );
        if (disposed) return;
        offers.replaceChildren(el("h2", {}, "Предложения заказов"));
        for (const o of rows)
          offers.append(
            card(
              el(
                "p",
                {},
                "Ответить до " +
                  new Date(o.expires_at).toLocaleTimeString("ru-RU"),
              ),
              act("Принять", async () => {
                await rpc("respond_taxi_offer", {
                  p_offer: o.id,
                  p_accept: true,
                });
                await refresh();
              }),
              act("Отклонить", async () => {
                await rpc("respond_taxi_offer", {
                  p_offer: o.id,
                  p_accept: false,
                });
                await refresh();
              }),
            ),
          );
      }
    } catch (error) {
      if (!disposed) toast(friendly(error));
    } finally {
      loading = false;
    }
  }
  await refresh();
  poll = setInterval(refresh, 10000);
  return () => {
    disposed = true;
    clearInterval(poll);
    stopLocation();
    routeMap?.remove();
  };
}
