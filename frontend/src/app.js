import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function fmtTime(iso) {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 19);
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  view: "readings", // readings | calibrations
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", gauge_code: "", microstrain: "" },
  calForm: { gauge_code: "", expires_at: "" },
  rows: [],
  calibrations: [],
  blocks: [],
  error: "",
  msg: "",
  calError: "",
  calMsg: "",
  loading: false,
  calSaving: false,
  timer: null,
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadAll() {
  if (!state.token) return;
  try {
    const [rows, calibrations, blocks] = await Promise.all([
      api("/api/readings"),
      api("/api/calibrations"),
      api("/api/blocks"),
    ]);
    state.rows = rows;
    state.calibrations = calibrations;
    state.blocks = blocks;
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadAll, 3000);
}

async function onLogin(e) {
  e.preventDefault();
  state.error = "";
  state.loading = true;
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(state.loginForm),
    });
    state.token = data.access_token;
    state.user = { username: data.username, role: data.role };
    localStorage.setItem(TOKEN_KEY, state.token);
    localStorage.setItem(USER_KEY, JSON.stringify(state.user));
    await loadAll();
    startPolling();
  } catch {
    state.error = "用户名或密码错误";
  } finally {
    state.loading = false;
    m.redraw();
  }
}

function onLogout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = "";
  state.user = null;
  state.rows = [];
  state.calibrations = [];
  state.blocks = [];
  if (state.timer) clearInterval(state.timer);
  m.redraw();
}

async function onSubmitReading(e) {
  e.preventDefault();
  state.error = "";
  state.msg = "";
  state.loading = true;
  try {
    const data = await api("/api/readings", {
      method: "POST",
      body: JSON.stringify({
        span_code: state.submitForm.span_code,
        gauge_code: state.submitForm.gauge_code,
        microstrain: parseFloat(state.submitForm.microstrain),
      }),
    });
    state.msg = data.message || "已提交";
    state.submitForm = { span_code: "", gauge_code: "", microstrain: "" };
    await loadAll();
  } catch (err) {
    // 校准到期/未登记被挡回时，这里展示服务端返回的挡回原因
    state.error = err.message || "提交失败";
    await loadAll();
  } finally {
    state.loading = false;
    m.redraw();
  }
}

async function onSaveCalibration(e) {
  e.preventDefault();
  state.calError = "";
  state.calMsg = "";
  state.calSaving = true;
  try {
    const code = state.calForm.gauge_code.trim();
    const data = await api(`/api/calibrations/${encodeURIComponent(code)}`, {
      method: "PUT",
      body: JSON.stringify({ expires_at: state.calForm.expires_at }),
    });
    state.calMsg = `已保存：片号 ${data.gauge_code} 到期日 ${data.expires_at}（${data.status}），报送写口同步生效`;
    state.calForm = { gauge_code: "", expires_at: "" };
    await loadAll();
  } catch (err) {
    state.calError = err.message || "保存失败";
  } finally {
    state.calSaving = false;
    m.redraw();
  }
}

function loginView() {
  return m("div.wrap", [
    m("h1", "桥梁应变班交台"),
    m(
      "p.sub",
      "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。"
    ),
    m("div.card", [
      m("form", { onsubmit: onLogin }, [
        m("div.row", [
          m("label", [
            "用户名",
            m("input", {
              value: state.loginForm.username,
              oninput: (e) => {
                state.loginForm.username = e.target.value;
              },
            }),
          ]),
          m("label", [
            "密码",
            m("input", {
              type: "password",
              value: state.loginForm.password,
              oninput: (e) => {
                state.loginForm.password = e.target.value;
              },
            }),
          ]),
          m("button", { type: "submit", disabled: state.loading }, "登录"),
        ]),
        state.error ? m("p.err", state.error) : null,
      ]),
      m(
        "p.sub",
        { style: { marginBottom: 0 } },
        "测量员 surveyor / surv123456 · 复核员（观察岗，只读）reviewer / rev123456"
      ),
    ]),
  ]);
}

function navView() {
  return m("div.nav", [
    m(
      "button",
      {
        type: "button",
        class: state.view === "readings" ? "active" : "",
        onclick: () => {
          state.view = "readings";
        },
      },
      "读数报送"
    ),
    m(
      "button",
      {
        type: "button",
        class: state.view === "calibrations" ? "active" : "",
        onclick: () => {
          state.view = "calibrations";
        },
      },
      "校准到期"
    ),
  ]);
}

function readingsView(isWriter) {
  return m("div", [
    isWriter
      ? m("div.card", [
          m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
          m("form", { onsubmit: onSubmitReading }, [
            m("div.row", [
              m("label", [
                "跨段编号",
                m("input", {
                  required: true,
                  placeholder: "例如 跨中S3",
                  value: state.submitForm.span_code,
                  oninput: (e) => {
                    state.submitForm.span_code = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "应变片片号",
                m("input", {
                  required: true,
                  placeholder: "例如 甲",
                  value: state.submitForm.gauge_code,
                  oninput: (e) => {
                    state.submitForm.gauge_code = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "微应变（με）",
                m("input", {
                  required: true,
                  type: "number",
                  step: "0.1",
                  value: state.submitForm.microstrain,
                  oninput: (e) => {
                    state.submitForm.microstrain = e.target.value;
                  },
                }),
              ]),
              m("button", { type: "submit", disabled: state.loading }, "提交"),
            ]),
            state.error ? m("p.err", state.error) : null,
            state.msg ? m("p.ok", state.msg) : null,
          ]),
        ])
      : null,
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "编号"),
            m("th", "跨段"),
            m("th", "片号"),
            m("th", "微应变"),
            m("th", "结论"),
            m("th", "说明"),
            m("th", "状态"),
            m("th", "提交人"),
          ]),
        ]),
        m(
          "tbody",
          state.rows.length
            ? state.rows.map((r) =>
                m("tr", { key: r.id }, [
                  m("td", r.id),
                  m("td", r.span_code),
                  m("td", r.gauge_code || "—"),
                  m("td", r.microstrain),
                  m("td", [
                    m(
                      "span",
                      { class: verdictClass(r.verdict, r.status) },
                      displayVerdict(r)
                    ),
                  ]),
                  m("td", r.reason || "—"),
                  m("td", r.status),
                  m("td", r.created_by),
                ])
              )
            : [m("tr", m("td", { colspan: 8 }, "暂无数据"))]
        ),
      ]),
    ]),
  ]);
}

function calibrationsView(isWriter) {
  return m("div", [
    isWriter
      ? m("div.card", [
          m(
            "h2",
            { style: { marginTop: 0, fontSize: "1.1rem" } },
            "维护校准到期日"
          ),
          m(
            "p.sub",
            "登记新片号，或对已有片号改期/续期。保存后与报送写口即时生效、判定口径一致。"
          ),
          m("form", { onsubmit: onSaveCalibration }, [
            m("div.row", [
              m("label", [
                "应变片片号",
                m("input", {
                  required: true,
                  placeholder: "例如 甲",
                  value: state.calForm.gauge_code,
                  oninput: (e) => {
                    state.calForm.gauge_code = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "校准到期日",
                m("input", {
                  required: true,
                  type: "date",
                  value: state.calForm.expires_at,
                  oninput: (e) => {
                    state.calForm.expires_at = e.target.value;
                  },
                }),
              ]),
              m(
                "button",
                { type: "submit", disabled: state.calSaving },
                "保存（登记/续期）"
              ),
            ]),
            state.calError ? m("p.err", state.calError) : null,
            state.calMsg ? m("p.ok", state.calMsg) : null,
          ]),
        ])
      : m(
          "div.card",
          m(
            "p.sub",
            { style: { margin: 0 } },
            "观察岗只读：校准到期日由测量员维护，以下为当前口径与拦截留痕。"
          )
        ),
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "片号到期日一览"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "片号"),
            m("th", "校准到期日"),
            m("th", "状态"),
            m("th", "维护人"),
            m("th", "维护时间"),
          ]),
        ]),
        m(
          "tbody",
          state.calibrations.length
            ? state.calibrations.map((c) =>
                m("tr", { key: c.gauge_code }, [
                  m("td", c.gauge_code),
                  m("td", c.expires_at),
                  m("td", [
                    m(
                      "span",
                      { class: c.expired ? "tag fail" : "tag pass" },
                      c.status
                    ),
                  ]),
                  m("td", c.updated_by),
                  m("td", fmtTime(c.updated_at)),
                ])
              )
            : [m("tr", m("td", { colspan: 5 }, "暂无登记"))]
        ),
      ]),
    ]),
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "拦截记录"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "时间"),
            m("th", "片号"),
            m("th", "跨段"),
            m("th", "微应变"),
            m("th", "拦截原因"),
            m("th", "提交人"),
          ]),
        ]),
        m(
          "tbody",
          state.blocks.length
            ? state.blocks.map((b) =>
                m("tr", { key: b.id }, [
                  m("td", fmtTime(b.created_at)),
                  m("td", b.gauge_code),
                  m("td", b.span_code),
                  m("td", b.microstrain),
                  m("td", b.reason),
                  m("td", b.attempted_by),
                ])
              )
            : [m("tr", m("td", { colspan: 6 }, "暂无拦截记录"))]
        ),
      ]),
    ]),
  ]);
}

const App = {
  oninit() {
    loadAll();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return loginView();
    }

    const isWriter = state.user?.role === "writer";

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m(
            "p.sub",
            "微应变 80～220 με 为合格，否则为越界；应变片校准到期后禁止再报送。"
          ),
        ]),
        m("div", [
          `${state.user?.username}（${isWriter ? "测量员" : "复核员·观察岗只读"}） `,
          m(
            "button.secondary",
            { type: "button", onclick: onLogout },
            "退出"
          ),
        ]),
      ]),
      navView(),
      state.view === "readings" ? readingsView(isWriter) : calibrationsView(isWriter),
    ]);
  },
};

export default App;
