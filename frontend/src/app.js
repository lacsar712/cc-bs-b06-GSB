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
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  // 校准到期专页数据
  view: "readings",
  gauges: [],
  blocks: [],
  calLog: [],
  gaugeEdits: {},
  newGauge: { span_code: "", calibrated_until: "" },
  error: "",
  msg: "",
  calError: "",
  calMsg: "",
  loading: false,
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
  if (!res.ok) {
    const err = new Error(data.detail || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

async function loadCalibration() {
  if (!state.token) return;
  try {
    const [gauges, blocks, calLog] = await Promise.all([
      api("/api/gauges"),
      api("/api/blocks"),
      api("/api/calibration-log"),
    ]);
    state.gauges = gauges;
    state.blocks = blocks;
    state.calLog = calLog;
    // 已登记片号的编辑框默认填当前到期日，新建片号的输入保留用户输入
    for (const g of gauges) {
      if (state.gaugeEdits[g.span_code] === undefined) {
        state.gaugeEdits[g.span_code] = g.calibrated_until;
      }
    }
  } catch {
    state.calError = "加载校准到期专页失败，请重新登录";
  }
  m.redraw();
}

function loadCurrentView() {
  if (state.view === "calibration") return loadCalibration();
  return loadReadings();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadCurrentView, 3000);
}

function switchView(view) {
  state.view = view;
  state.error = "";
  state.msg = "";
  state.calError = "";
  state.calMsg = "";
  loadCurrentView();
  startPolling();
}

async function saveGauge(spanCode, until, note) {
  state.calError = "";
  state.calMsg = "";
  try {
    const g = await api(`/api/gauges/${encodeURIComponent(spanCode)}`, {
      method: "PUT",
      body: JSON.stringify({ calibrated_until: until, note: note || "" }),
    });
    state.gaugeEdits[spanCode] = g.calibrated_until;
    state.calMsg = `片号 ${spanCode} 已保存：${g.status_phrase}`;
    await loadCalibration();
  } catch (err) {
    state.calError = err.message || "保存失败";
  }
  m.redraw();
}

const GaugePage = {
  view() {
    const isWriter = state.user?.role === "writer";
    return [
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "片号到期日一览"),
        m(
          "p.sub",
          { style: { marginBottom: "0.75rem" } },
          "到期状态与报送写口由同一规则判定：到期日早于今天即已到期，禁止报送，续期后才许再报。"
        ),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "片号"),
              m("th", "校准有效期至"),
              m("th", "到期状态"),
              m("th", "维护人 / 时间"),
              isWriter ? m("th", "维护到期日") : null,
            ]),
          ]),
          m(
            "tbody",
            state.gauges.length
              ? state.gauges.map((g) =>
                  m("tr", { key: g.span_code, class: g.expired ? "row-expired" : "" }, [
                    m("td", g.span_code),
                    m("td", g.calibrated_until),
                    m("td", [
                      m(
                        "span",
                        { class: g.expired ? "tag fail" : "tag pass" },
                        // 专页状态原样展示服务端句子，与写口拦截提示同一句话
                        g.status_phrase
                      ),
                    ]),
                    m("td", `${g.updated_by} · ${fmtTime(g.updated_at)}`),
                    isWriter
                      ? m("td", [
                          m("div.row", { style: { gap: "0.4rem" } }, [
                            m("input", {
                              type: "date",
                              value: state.gaugeEdits[g.span_code] || g.calibrated_until,
                              oninput: (e) => {
                                state.gaugeEdits[g.span_code] = e.target.value;
                              },
                            }),
                            m(
                              "button",
                              {
                                type: "button",
                                onclick: () =>
                                  saveGauge(
                                    g.span_code,
                                    state.gaugeEdits[g.span_code],
                                    ""
                                  ),
                              },
                              "保存 / 续期"
                            ),
                          ]),
                        ])
                      : null,
                  ])
                )
              : [m("tr", m("td", { colspan: isWriter ? 5 : 4 }, "暂无片号"))]
          ),
        ]),
        isWriter
          ? m(
              "form",
              {
                style: { marginTop: "0.9rem" },
                onsubmit: async (e) => {
                  e.preventDefault();
                  const code = state.newGauge.span_code.trim();
                  if (!code || !state.newGauge.calibrated_until) return;
                  await saveGauge(code, state.newGauge.calibrated_until, "新登记片号");
                  state.newGauge = { span_code: "", calibrated_until: "" };
                },
              },
              [
                m("div.row", [
                  m("label", [
                    "新片号",
                    m("input", {
                      placeholder: "例如 片号丙",
                      value: state.newGauge.span_code,
                      oninput: (e) => {
                        state.newGauge.span_code = e.target.value;
                      },
                    }),
                  ]),
                  m("label", [
                    "校准有效期至",
                    m("input", {
                      type: "date",
                      value: state.newGauge.calibrated_until,
                      oninput: (e) => {
                        state.newGauge.calibrated_until = e.target.value;
                      },
                    }),
                  ]),
                  m("button", { type: "submit" }, "登记片号"),
                ]),
              ]
            )
          : m(
              "p.sub",
              { style: { marginBottom: 0, marginTop: "0.75rem" } },
              "观察岗只读：到期日由测量员维护。"
            ),
        state.calError ? m("p.err", state.calError) : null,
        state.calMsg ? m("p.ok", state.calMsg) : null,
      ]),
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "拦截记录"),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "时间"),
              m("th", "片号"),
              m("th", "微应变"),
              m("th", "报送人"),
              m("th", "当时到期日"),
              m("th", "拦截原因"),
            ]),
          ]),
          m(
            "tbody",
            state.blocks.length
              ? state.blocks.map((b) =>
                  m("tr", { key: b.id }, [
                    m("td", fmtTime(b.blocked_at)),
                    m("td", b.span_code),
                    m("td", b.microstrain),
                    m("td", b.blocked_by),
                    m("td", b.calibrated_until),
                    m("td", b.reason),
                  ])
                )
              : [m("tr", m("td", { colspan: 6 }, "暂无拦截记录"))]
          ),
        ]),
      ]),
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "续期 / 到期日维护留痕"),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "时间"),
              m("th", "片号"),
              m("th", "校准有效期至"),
              m("th", "操作人"),
              m("th", "说明"),
            ]),
          ]),
          m(
            "tbody",
            state.calLog.length
              ? state.calLog.map((l) =>
                  m("tr", { key: l.id }, [
                    m("td", fmtTime(l.changed_at)),
                    m("td", l.span_code),
                    m("td", l.calibrated_until),
                    m("td", l.changed_by),
                    m("td", l.note),
                  ])
                )
              : [m("tr", m("td", { colspan: 5 }, "暂无续期记录"))]
          ),
        ]),
      ]),
    ];
  },
};

const App = {
  oninit() {
    if (state.token) {
      loadCurrentView();
      startPolling();
    }
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return m(
        "div.wrap",
        [
          m("h1", "桥梁应变班交台"),
          m(
            "p.sub",
            "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。应变片校准到期后禁止报送。"
          ),
          m("div.card", [
            m(
              "form",
              {
                onsubmit: async (e) => {
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
                    await loadCurrentView();
                    startPolling();
                  } catch {
                    state.error = "用户名或密码错误";
                  } finally {
                    state.loading = false;
                    m.redraw();
                  }
                },
              },
              [
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
                  m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "登录"
                  ),
                ]),
                state.error ? m("p.err", state.error) : null,
              ]
            ),
            m(
              "p.sub",
              { style: { marginBottom: 0 } },
              "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
            ),
          ]),
        ]
      );
    }

    const isWriter = state.user?.role === "writer";

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。校准到期片号禁止报送。"),
        ]),
        m("div", { style: { display: "flex", gap: "0.5rem", alignItems: "center" } }, [
          m(
            "button",
            {
              type: "button",
              class: state.view === "readings" ? "" : "secondary",
              onclick: () => switchView("readings"),
            },
            "班交读数"
          ),
          m(
            "button",
            {
              type: "button",
              class: state.view === "calibration" ? "" : "secondary",
              onclick: () => switchView("calibration"),
            },
            "校准到期"
          ),
          m("span", { style: { marginLeft: "0.5rem" } }, `${state.user?.username}（${isWriter ? "测量员" : "复核员"}）`),
          m(
            "button.secondary",
            {
              type: "button",
              onclick: () => {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
                state.token = "";
                state.user = null;
                state.rows = [];
                state.gauges = [];
                state.blocks = [];
                state.calLog = [];
                if (state.timer) clearInterval(state.timer);
                m.redraw();
              },
            },
            "退出"
          ),
        ]),
      ]),
      state.view === "calibration"
        ? m(GaugePage)
        : [
            isWriter
              ? m("div.card", [
                  m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
                  m(
                    "form",
                    {
                      onsubmit: async (e) => {
                        e.preventDefault();
                        state.error = "";
                        state.msg = "";
                        state.loading = true;
                        try {
                          const data = await api("/api/readings", {
                            method: "POST",
                            body: JSON.stringify({
                              span_code: state.submitForm.span_code,
                              microstrain: parseFloat(state.submitForm.microstrain),
                            }),
                          });
                          state.msg = data.message || "已提交";
                          state.submitForm = { span_code: "", microstrain: "" };
                          await loadReadings();
                        } catch (err) {
                          // 被挡回时直接展示写口返回的同一句话（与专页状态同源）
                          state.error = err.message || "提交失败";
                        } finally {
                          state.loading = false;
                          m.redraw();
                        }
                      },
                    },
                    [
                      m("div.row", [
                        m("label", [
                          "片号 / 跨段编号",
                          m("input", {
                            required: true,
                            placeholder: "例如 片号甲",
                            value: state.submitForm.span_code,
                            oninput: (e) => {
                              state.submitForm.span_code = e.target.value;
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
                        m(
                          "button",
                          { type: "submit", disabled: state.loading },
                          "提交"
                        ),
                      ]),
                      state.error ? m("p.err", state.error) : null,
                      state.msg ? m("p.ok", state.msg) : null,
                    ]
                  ),
                ])
              : null,
            m("div.card", [
              m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
              m("table", [
                m("thead", [
                  m("tr", [
                    m("th", "编号"),
                    m("th", "片号 / 跨段"),
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
                    : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
                ),
              ]),
            ]),
          ],
    ]);
  },
};

export default App;
