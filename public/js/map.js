import { config } from "./config.js";
import { client, unwrap, rpc, friendly } from "./api.js";
import { el, field, card, busy, toast, empty } from "./ui.js";
import { uuid } from "./id.js";
export async function mapPage(app, session) {
  const roles = await unwrap(
    client.from("user_roles").select("role").eq("user_id", session.user.id),
  );
  await import("../vendor/leaflet/leaflet.js");
  const L = window.L;
  let disposed = false,
    timer = null,
    version = 0;
  const heading = el("h1", {}, "Карта посёлка"),
    hint = el(
      "p",
      {},
      "Публичные объекты, здания и события. Поиск работает по названиям и адресам, добавленным в Капани. Начальный обзор — Елецкий район; точное положение объектов задаёт мэрия.",
    );
  const host = el("div", {
      class: "village-map",
      "aria-label": "Интерактивная карта",
      tabindex: "0",
    }),
    list = el("div", { class: "grid" }),
    status = el("p", { "aria-live": "polite", class: "small muted" }),
    search = el("input", {
      type: "search",
      placeholder: "Название или адрес объекта",
      "aria-label": "Поиск объектов",
    }),
    searchButton = el("button", { type: "button" }, "Найти");
  app.append(
    heading,
    hint,
    el("div", { class: "actions" }, search, searchButton),
    status,
    host,
    list,
  );
  const map = L.map(host, { worldCopyJump: true, zoomControl: false }).setView(
    config.mapCenter,
    11,
  );
  L.control
    .zoom({ zoomInTitle: "Приблизить", zoomOutTitle: "Отдалить" })
    .addTo(map);
  const markers = L.layerGroup().addTo(map);
  if (config.mapTiles) {
    const tiles = L.tileLayer(config.mapTiles, {
      maxZoom: 19,
      attribution: config.mapAttribution,
    }).addTo(map);
    tiles.on("tileerror", () => {
      status.textContent =
        "Фоновая карта недоступна. Данные объектов остаются в списке.";
    });
  } else {
    host.before(
      el(
        "p",
        { class: "notice" },
        "Фоновая карта не подключена. Доступны координаты и поиск публичных объектов; схема не показывает дороги.",
      ),
    );
  }
  async function load(globalSearch = false) {
    const current = ++version,
      b = map.getBounds();
    status.textContent = "Загружаем объекты…";
    try {
      const points = await rpc("map_points", {
        p_south: globalSearch ? -85 : b.getSouth(),
        p_west: globalSearch ? -180 : Math.max(-180, b.getWest()),
        p_north: globalSearch ? 85 : b.getNorth(),
        p_east: globalSearch ? 180 : Math.min(180, b.getEast()),
        p_search: search.value.trim(),
      });
      if (disposed || current !== version) return;
      markers.clearLayers();
      list.replaceChildren();
      for (const p of points) {
        const popup = el(
          "div",
          {},
          el("strong", {}, p.title),
          el("p", {}, p.address),
          el("a", { href: p.href }, "Открыть раздел"),
        );
        L.circleMarker([Number(p.latitude), Number(p.longitude)], {
          radius: 8,
          color: "#dbeade",
          fillColor: "#176345",
          fillOpacity: 1,
          weight: 2,
        })
          .addTo(markers)
          .bindPopup(popup);
        const locate = el(
          "button",
          {
            type: "button",
            class: "quiet",
            onClick: () =>
              map.setView([Number(p.latitude), Number(p.longitude)], 16),
          },
          "Показать на карте",
        );
        list.append(
          card(
            el("h3", {}, p.title),
            el("p", {}, p.address),
            locate,
            el("a", { href: p.href }, "Открыть раздел"),
          ),
        );
      }
      status.textContent = `Объектов ${points.length}${points.length === 200 ? " · приблизь карту для уточнения" : ""}`;
      if (!points.length)
        list.append(empty("В этой области подходящих объектов пока нет"));
      if (globalSearch && points.length)
        map.fitBounds(
          points.map((p) => [Number(p.latitude), Number(p.longitude)]),
          { maxZoom: 16, padding: [30, 30] },
        );
    } catch (error) {
      if (!disposed && current === version)
        status.textContent = friendly(error);
    }
  }
  map.on("moveend", () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(), 300);
  });
  searchButton.onclick = () => load(true);
  search.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      load(true);
    }
  };
  if (roles.some((r) => r.role === "mayor")) {
    const f = el(
        "form",
        { class: "card" },
        el("h2", {}, "Добавить публичный объект"),
      ),
      title = field(f, "Название", "title"),
      description = field(f, "Описание", "description", "textarea"),
      address = field(f, "Адрес", "address"),
      lat = field(f, "Широта", "latitude", "number"),
      lng = field(f, "Долгота", "longitude", "number");
    lat.step = lng.step = "any";
    lat.min = "-85";
    lat.max = "85";
    lng.min = "-180";
    lng.max = "180";
    const submit = el("button", { type: "submit" }, "Сохранить объект");
    f.append(
      el(
        "p",
        { class: "small" },
        "Нажатие на карту заполняет координаты. Добавляй только публичные объекты.",
      ),
      submit,
    );
    app.append(el("details", {}, el("summary", {}, "Управление объектами"), f));
    map.on("click", (e) => {
      lat.value = e.latlng.lat.toFixed(6);
      lng.value = e.latlng.lng.toFixed(6);
    });
    let id = uuid();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await busy(submit, () =>
          rpc("save_map_place", {
            p_id: id,
            p_title: title.value,
            p_description: description.value,
            p_address: address.value,
            p_latitude: Number(lat.value),
            p_longitude: Number(lng.value),
            p_active: true,
          }),
        );
        id = uuid();
        f.reset();
        await load();
      } catch (error) {
        toast(friendly(error));
      }
    };
  }
  await load();
  map.invalidateSize();
  return () => {
    disposed = true;
    version++;
    clearTimeout(timer);
    map.remove();
  };
}
