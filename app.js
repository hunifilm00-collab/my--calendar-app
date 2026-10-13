// 화면, 저장, 이벤트만 다룬다. 계산 규칙은 scheduler.js를 부른다(spec 3장).
(function () {
  const S = globalThis.Scheduler;
  // 백업 모듈(sync.js)이 없거나 설정이 비어 있어도 앱은 이 기기의 저장만으로 동작한다
  const Backup = globalThis.Backup || { enabled: false };

  const STORAGE_KEY = "jaksim.v2";
  const STATE_VERSION = 3;
  const MAX_NAME_LENGTH = 20;
  const MAX_TITLE_LENGTH = 30;
  const MAX_UNIT_LENGTH = 6;
  const MAX_AMOUNT = 9999;
  const DEFAULT_UNIT = "개";
  const MAX_BARS_PER_CELL = 2;
  // 프로젝트 색은 목록 순서대로 5가지를 돌려 쓴다. 흰 글자와의 대비가 4.5 이상인 어두운 색만 쓴다(spec 4-1)
  const PROJECT_COLORS = ["#1f2430", "#ab3500", "#0f6b6b", "#5c6b1f", "#7a3b6e"];
  const WEEKDAY_SHORT = ["일", "월", "화", "수", "목", "금", "토"];
  const WEEKDAY_LONG = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

  // ---------- 작은 도우미 ----------

  // 사용자 입력은 항상 textContent로만 넣는다. innerHTML은 쓰지 않는다
  function el(tag, props, children) {
    const node = document.createElement(tag);
    const attrs = props || {};
    Object.keys(attrs).forEach(function (key) {
      const value = attrs[key];
      if (value === undefined || value === null || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2), value);
      else if (key === "value" || key === "checked" || key === "disabled" || key === "hidden") node[key] = value;
      else node.setAttribute(key, value === true ? "" : value);
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function svgUse(id, size, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (className) svg.setAttribute("class", className);
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function byId(id) { return document.getElementById(id); }

  // 오늘은 사용자 기기의 로컬 날짜로 정한다(spec 4-1)
  function getToday() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return now.getFullYear() + "-" + month + "-" + day;
  }

  function splitDate(date) {
    const parts = date.split("-");
    return { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
  }

  function formatDay(date) {
    const parts = splitDate(date);
    return parts.month + "월 " + parts.day + "일(" + WEEKDAY_SHORT[S.getWeekday(date)] + ")";
  }

  function formatLongLabel(date) {
    const parts = splitDate(date);
    return parts.month + "월 " + parts.day + "일 " + WEEKDAY_LONG[S.getWeekday(date)];
  }

  function colorOf(index) { return PROJECT_COLORS[index % PROJECT_COLORS.length]; }

  function focusLater(selector, root) {
    const target = (root || document).querySelector(selector);
    if (target) target.focus();
  }

  // ---------- 저장 ----------

  function createEmptyState() {
    return { version: STATE_VERSION, projects: [], draft: null, createdAt: Date.now(), updatedAt: Date.now() };
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isValidProject(project) {
    return isPlainObject(project) && Array.isArray(project.tasks)
      && isPlainObject(project.settings) && isPlainObject(project.plan)
      && Array.isArray(project.plan.blocks) && S.isValidDate(project.plan.startDate);
  }

  function isValidState(value) {
    return isPlainObject(value) && value.version === STATE_VERSION
      && Array.isArray(value.projects) && value.projects.every(isValidProject);
  }

  // 이전 형식(version 2)은 프로젝트 하나로 옮긴다. 미리보기 상태였다면 작성 중인 프로젝트로 옮긴다(spec 4-4, 사례 12)
  function migrateV2(old) {
    const next = createEmptyState();
    if (old.plan.status === "draft") {
      next.draft = {
        name: "",
        lines: old.tasks.map(function (task) {
          return {
            title: String(task.title || ""),
            amount: String(task.amount || ""),
            unit: String(task.unit || ""),
            deadline: task.deadline || "",
          };
        }),
        finalDeadline: (old.settings && old.settings.finalDeadline) || "",
      };
      return next;
    }
    next.projects.push({
      id: "p1",
      name: "프로젝트 1",
      tasks: old.tasks,
      settings: old.settings,
      plan: old.plan,
    });
    return next;
  }

  function loadState() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return { state: createEmptyState(), notice: "이 브라우저에서는 저장되지 않아요", canSave: false };
    }
    if (!raw) return { state: createEmptyState(), notice: "", canSave: true };
    try {
      const parsed = JSON.parse(raw);
      if (isValidState(parsed)) return { state: parsed, notice: "", canSave: true };
      if (isPlainObject(parsed) && parsed.version === 2 && Array.isArray(parsed.tasks)
        && isPlainObject(parsed.settings) && isPlainObject(parsed.plan) && Array.isArray(parsed.plan.blocks)) {
        return { state: migrateV2(parsed), notice: "", canSave: true };
      }
    } catch (error) {
      // 깨진 값은 아래에서 함께 버린다
    }
    return { state: createEmptyState(), notice: "저장된 값을 읽지 못해 빈 상태로 시작했어요", canSave: true };
  }

  let state = createEmptyState();
  let storageWorks = true;

  function setNotice(text) {
    const box = byId("notice");
    box.textContent = text;
    box.hidden = !text;
  }

  // touch가 false이면 수정 시각을 올리지 않는다. 시작할 때 옛 형식을 옮겨 저장하는 경우가 그렇다.
  // 시각을 올리면 백업과 비교할 때 이 기기가 항상 최신으로 보이기 때문이다
  function persist(touch) {
    if (touch !== false) state.updatedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (storageWorks) setNotice("");
    } catch (error) {
      setNotice(storageWorks ? "저장되지 않았어요" : "이 브라우저에서는 저장되지 않아요");
    }
    if (touch !== false) scheduleBackup();
  }

  // ---------- 백업(Supabase 익명 백업) ----------

  const BACKUP_DELAY_MS = 1500;
  let backupTimer = null;
  let backupReady = false; // 시작할 때 백업과 비교를 끝내기 전에는 올리지 않는다

  function hasContent(target) {
    return target.projects.length > 0 || Boolean(target.draft);
  }

  function setBackupStatus(text) {
    const box = byId("backup-status");
    box.textContent = text;
    box.hidden = !text;
  }

  function formatClock(time) {
    const date = new Date(time);
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  }

  async function pushBackup() {
    try {
      await Backup.push(state);
      setBackupStatus("백업했어요 · " + formatClock(Date.now()));
    } catch (error) {
      setBackupStatus("백업하지 못했어요. 이 기기에는 저장돼 있어요");
    }
  }

  // 입력이 이어지는 동안 서버를 계속 부르지 않도록 잠깐 모았다가 한 번에 올린다
  function scheduleBackup() {
    if (!Backup.enabled || !backupReady) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(pushBackup, BACKUP_DELAY_MS);
  }

  function restoreFromBackup(remote) {
    state = remote.state;
    persist(false);
    ui.selected = null;
    ui.homeMonth = null;
    ui.editingKey = null;
    ui.overdueOpen = null;
    renderHome();
    setBackupStatus("백업에서 불러왔어요 · " + formatClock(remote.updatedAt));
  }

  // 시작할 때 백업과 이 기기를 비교한다. 이 기기가 비어 있으면 바로 불러오고,
  // 둘 다 내용이 있는데 백업이 더 최신이면 어느 쪽을 쓸지 묻는다
  async function syncOnStart() {
    if (!Backup.enabled) return;
    try {
      const remote = await Backup.pull();
      const remoteUsable = remote && isValidState(remote.state) && hasContent(remote.state);
      if (remoteUsable && !hasContent(state)) {
        restoreFromBackup(remote);
      } else if (remoteUsable && remote.updatedAt > state.updatedAt) {
        const useBackup = await confirmDialog("이 기기보다 최신 백업이 있어요. 백업을 불러올까요?", "백업 불러오기", "이 기기 유지");
        if (useBackup) restoreFromBackup(remote);
        else await pushBackup();
      } else if (hasContent(state)) {
        await pushBackup();
      }
      backupReady = true;
    } catch (error) {
      backupReady = true;
      setBackupStatus("백업에 연결하지 못했어요. 이 기기에는 저장돼 있어요");
    }
  }

  // ---------- 화면 상태(저장하지 않는다) ----------

  const ui = {
    screen: "home",
    homeMonth: null,
    selected: null,
    editingKey: null,
    overdueOpen: null,
    previewPlan: null,
    previewOriginal: "",
    previewMonth: null,
    previewTasks: [],
    previewName: "",
    touched: {},
    announce: "",
  };

  function showScreen(name) {
    ui.screen = name;
    document.querySelectorAll("[data-screen]").forEach(function (section) {
      section.hidden = section.dataset.screen !== name;
    });
    const heading = document.querySelector('[data-screen="' + name + '"] h2');
    if (heading) heading.focus();
  }

  // ---------- 블록 문맥 ----------

  function findTask(project, taskId) {
    return project.tasks.find(function (task) { return task.id === taskId; });
  }

  function listConfirmedContexts() {
    const contexts = [];
    state.projects.forEach(function (project, index) {
      project.plan.blocks.forEach(function (block) {
        const task = findTask(project, block.taskId);
        if (!task) return;
        contexts.push({
          kind: "project",
          projectId: project.id,
          projectName: project.name,
          colorIndex: index,
          block: block,
          task: task,
          deadline: S.resolveDeadline(task, project.settings.finalDeadline, project.plan.startDate),
          key: project.id + "/" + block.id,
        });
      });
    });
    return contexts;
  }

  function listPreviewContexts() {
    return ui.previewPlan.blocks.map(function (block) {
      const task = ui.previewTasks.find(function (item) { return item.id === block.taskId; });
      return {
        kind: "preview",
        projectId: "preview",
        projectName: ui.previewName,
        colorIndex: 0,
        block: block,
        task: task,
        deadline: S.resolveDeadline(task, ui.previewFinalDeadline, ui.previewPlan.startDate),
        key: "preview/" + block.id,
      };
    });
  }

  function amountText(context) {
    return context.block.amount + (context.task.unit || DEFAULT_UNIT);
  }

  // ---------- 달력 ----------

  // opts: year, month, contexts, selected, today, prefix, onMonth(delta), onSelect(date)
  function renderCalendar(container, opts) {
    clear(container);
    const titleText = opts.year + "년 " + opts.month + "월";

    const prev = el("button", {
      type: "button",
      "aria-label": "이전 달",
      "data-focus": opts.prefix + "prev",
      onclick: function () { opts.onMonth(-1, opts.prefix + "prev"); },
    }, [svgUse("icon-chevron-left", 8)]);
    const next = el("button", {
      type: "button",
      "aria-label": "다음 달",
      "data-focus": opts.prefix + "next",
      onclick: function () { opts.onMonth(1, opts.prefix + "next"); },
    }, [svgUse("icon-chevron-right", 8)]);
    // 달이 바뀌면 달 이름을 읽어 준다(spec 6-6)
    const title = el("span", { class: "cal-title", "aria-live": "polite" }, [svgUse("icon-calendar", 14), titleText]);
    container.appendChild(el("div", { class: "cal-nav" }, [prev, title, next]));

    const week = el("div", { class: "cal-week", "aria-hidden": "true" }, WEEKDAY_SHORT.map(function (name, index) {
      return el("span", { class: index === 0 ? "is-sun" : "", text: name });
    }));

    const byDate = {};
    opts.contexts.forEach(function (context) {
      (byDate[context.block.date] = byDate[context.block.date] || []).push(context);
    });

    const grid = el("div", { class: "cal-grid" });
    S.getMonthCells(opts.year, opts.month).forEach(function (cell) {
      const date = cell.date;
      const parts = splitDate(date);
      const isSun = S.getWeekday(date) === 0;
      const items = byDate[date] || [];
      const isToday = date === opts.today;
      const isSelected = date === opts.selected;

      const top = el("span", { class: "cal-top" }, [
        el("span", { class: "cal-day" + (isSun ? " is-sun" : ""), text: String(parts.day) }),
        isToday ? el("span", { class: "cal-today-tag", text: "오늘" }) : null,
        items.some(function (item) { return item.block.edited; }) ? el("span", { class: "cal-dot" }) : null,
      ]);

      const bars = el("span", { class: "cal-bars" });
      items.slice(0, MAX_BARS_PER_CELL).forEach(function (item) {
        const bar = el("span", {
          class: "cal-bar" + (item.block.done ? " is-done" : ""),
          text: item.task.title,
        });
        bar.style.background = colorOf(item.colorIndex);
        bars.appendChild(bar);
      });
      if (items.length > MAX_BARS_PER_CELL) {
        bars.appendChild(el("span", { class: "cal-more", text: "+" + (items.length - MAX_BARS_PER_CELL) }));
      }

      const classes = "cal-cell" + (cell.inMonth ? "" : " is-outside") + (isToday ? " is-today" : "") + (isSelected ? " is-selected" : "");
      if (!cell.inMonth) {
        // 이웃 달 칸은 보기만 하고 누를 수 없다
        grid.appendChild(el("div", { class: classes, "aria-hidden": "true" }, [top, bars]));
        return;
      }

      const label = formatLongLabel(date) + ", "
        + (items.length ? "할 일 " + items.length + "건" + (items.some(function (item) { return item.block.edited; }) ? ", 수정됨 포함" : "") : "일정 없음");
      grid.appendChild(el("button", {
        type: "button",
        class: classes,
        "aria-label": label,
        "aria-pressed": isSelected ? "true" : "false",
        "data-focus": opts.prefix + date,
        onclick: function () { opts.onSelect(date, opts.prefix + date); },
      }, [top, bars]));
    });

    const legend = el("div", { class: "legend" }, [
      el("span", {}, [el("i", { class: "sw-today" }), "오늘"]),
      el("span", {}, [el("i", { class: "sw-dot" }), "수정됨"]),
      el("span", {}, [el("i", { class: "sw-done" }), "한 일"]),
    ]);

    container.appendChild(el("div", { class: "cal-card" }, [week, grid, legend]));
  }

  // ---------- 블록 줄과 수정 영역 ----------

  function makeCheck(context, onChange) {
    const label = context.projectName + " " + context.task.title + " " + formatDay(context.block.date) + " " + amountText(context);
    return el("label", { class: "check" }, [
      el("input", {
        type: "checkbox",
        checked: context.block.done,
        "aria-label": label,
        "data-focus": "check:" + context.key,
        onchange: function (event) { onChange(event.target.checked); },
      }),
      svgUse("icon-check", 14),
    ]);
  }

  // 블록 줄은 홈 패널, 밀린 일, 미리보기 목록에서 같은 모양이다(spec 6-7)
  function renderBlockRow(context, opts) {
    const exceeded = S.countExceededDays(context.block.date, context.deadline);
    const text = el("span", { class: "block-text" }, [
      el("span", { class: "block-title" + (context.block.done ? " is-done" : ""), text: context.task.title }),
      opts.showProject ? (function () {
        const pill = el("span", { class: "pill", text: context.projectName });
        pill.style.background = colorOf(context.colorIndex);
        return pill;
      })() : null,
      el("span", { class: "block-amount", text: amountText(context) }),
      context.block.edited && opts.showEdited ? el("span", { class: "tag", text: "수정됨" }) : null,
      exceeded > 0 ? el("span", { class: "tag tag-late", text: "마감 " + exceeded + "일 초과" }) : null,
      opts.showOrigin ? el("span", { class: "block-origin", text: formatDay(context.block.date) + " 몫" }) : null,
    ]);

    const main = el("div", { class: "block-main" }, [
      opts.onCheck ? makeCheck(context, opts.onCheck) : null,
      text,
    ]);

    const editButton = opts.onEdit && !context.block.done
      ? el("button", {
        type: "button",
        class: "link",
        text: "수정",
        "aria-label": context.task.title + " 수정",
        "data-focus": "edit:" + context.key,
        onclick: function () { opts.onEdit(context); },
      })
      : null;

    const item = el("li", { class: "block-item" }, [el("div", { class: "block-row" }, [main, editButton])]);
    if (ui.editingKey === context.key && opts.onEdit) {
      item.appendChild(renderEditPanel(context, opts));
    }
    return item;
  }

  function renderEditPanel(context, opts) {
    const today = getToday();
    // 원래 날짜가 오늘 이전이면 그 날짜는 그대로 둘 수 있다(spec 6-7)
    const minDate = context.block.date < today ? context.block.date : today;
    const dateInput = el("input", {
      class: "input",
      type: "date",
      id: "edit-date",
      value: context.block.date,
      min: minDate,
      "data-edit-date": "1",
    });
    const amountInput = el("input", {
      class: "input",
      type: "number",
      id: "edit-amount",
      min: "1",
      step: "1",
      value: String(context.block.amount),
      style: "max-width:120px",
    });
    const error = el("p", { class: "error", role: "alert" });

    const save = el("button", {
      type: "button",
      class: "btn btn-primary",
      text: "저장",
      onclick: function () {
        const date = dateInput.value;
        const amount = Number(amountInput.value);
        if (!S.isValidDate(date) || date < minDate) {
          error.textContent = "오늘 이후의 날짜를 골라 주세요";
          return;
        }
        if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
          error.textContent = "분량은 1 이상의 정수로 적어 주세요";
          return;
        }
        opts.onSave(context, date, amount);
      },
    });
    const cancel = el("button", {
      type: "button",
      class: "btn btn-secondary",
      text: "취소",
      onclick: function () { opts.onCancel(context); },
    });

    return el("div", { class: "panel" }, [
      el("div", { class: "panel-row" }, [el("label", { for: "edit-date", text: "날짜" }), dateInput]),
      el("div", { class: "panel-row" }, [
        el("label", { for: "edit-amount", text: "분량(" + (context.task.unit || DEFAULT_UNIT) + ")" }),
        amountInput,
      ]),
      error,
      el("div", { class: "panel-actions" }, [save, cancel]),
    ]);
  }

  // 날짜 이동과 분량 변경을 한 번에 적용한다(spec 5-3). 미리보기에서는 '수정됨'을 붙이지 않는다
  function applyEdit(blocks, context, date, amount, markEdited) {
    let result = blocks;
    if (amount !== context.block.amount) {
      result = S.changeBlockAmount(result, context.block.id, amount, markEdited);
    }
    if (date !== context.block.date) {
      result = S.moveBlock(result, context.block.id, date, markEdited);
    }
    return result;
  }

  function updateProjectBlocks(projectId, change) {
    const project = state.projects.find(function (item) { return item.id === projectId; });
    if (!project) return;
    project.plan = Object.assign({}, project.plan, { blocks: change(project.plan.blocks) });
    persist();
  }

  // ---------- 홈 ----------

  function ensureHomeView() {
    const today = getToday();
    if (!ui.selected) ui.selected = today;
    if (!ui.homeMonth) {
      const parts = splitDate(today);
      ui.homeMonth = { year: parts.year, month: parts.month };
    }
  }

  function renderHome(focusSelector) {
    ensureHomeView();
    const today = getToday();
    const contexts = listConfirmedContexts();
    const blocks = contexts.map(function (context) { return context.block; });

    // 머리줄 버튼
    const addButton = byId("add-project");
    const limitReached = state.projects.length >= S.MAX_PROJECTS;
    byId("add-project-label").textContent = state.draft ? "작성 중인 프로젝트 이어서 쓰기" : "프로젝트 추가";
    addButton.disabled = limitReached && !state.draft;
    byId("project-limit").hidden = !(limitReached && !state.draft);

    // 완료 문구(spec 6-3). 모든 일을 마친 경우가 우선이다
    const notice = byId("done-notice");
    clear(notice);
    const allDone = S.isAllDone(blocks);
    const todayDone = S.isTodayDone(blocks, today);
    notice.hidden = !(allDone || todayDone);
    if (allDone || todayDone) {
      notice.appendChild(svgUse("mascot", 24));
      notice.appendChild(el("span", { text: allDone ? "모든 일을 마쳤어요" : "오늘 몫을 마쳤어요" }));
    }

    renderCalendar(byId("home-calendar"), {
      year: ui.homeMonth.year,
      month: ui.homeMonth.month,
      contexts: contexts,
      selected: ui.selected,
      today: today,
      prefix: "h-",
      onMonth: function (delta, focus) {
        ui.homeMonth = S.shiftMonth(ui.homeMonth.year, ui.homeMonth.month, delta);
        renderHome("[data-focus='" + focus + "']");
      },
      onSelect: function (date, focus) {
        ui.selected = date;
        ui.editingKey = null;
        renderHome("[data-focus='" + focus + "']");
      },
    });

    renderDayPanel(contexts, today);
    renderOverdue(contexts, today);
    renderProjects(today);

    if (focusSelector) focusLater(focusSelector, byId("screen-home"));
  }

  function toggleDone(context, done, focusSelector) {
    updateProjectBlocks(context.projectId, function (blocks) {
      return blocks.map(function (block) {
        return block.id === context.block.id ? Object.assign({}, block, { done: done }) : block;
      });
    });
    renderHome(focusSelector);
  }

  function renderDayPanel(contexts, today) {
    const panel = byId("day-panel");
    clear(panel);
    const dayContexts = contexts.filter(function (context) { return context.block.date === ui.selected; });
    const isToday = ui.selected === today;
    panel.classList.toggle("is-today", isToday);

    const doneCount = dayContexts.filter(function (context) { return context.block.done; }).length;
    const allDone = dayContexts.length > 0 && doneCount === dayContexts.length;
    const titleText = (isToday ? "오늘 · " : "") + formatDay(ui.selected);
    const head = el("div", { class: "card-head" }, [
      el("h3", { id: "day-panel-title", tabindex: "-1" }, [
        titleText,
        isToday && dayContexts.length ? el("span", { class: "chip", text: allDone ? "완료" : "진행 중" }) : null,
      ]),
      dayContexts.length ? el("span", { class: "count", text: doneCount + " / " + dayContexts.length + " 완료" }) : null,
    ]);
    panel.appendChild(head);

    if (!dayContexts.length) {
      let message;
      if (!state.projects.length && isToday) message = "아직 프로젝트가 없어요. 프로젝트 추가로 시작해 보세요";
      else message = isToday ? "오늘 할 일은 없어요" : "이 날은 일정이 없어요";
      panel.appendChild(el("p", { class: "empty-box", text: message }));
      return;
    }

    const list = el("ul", { class: "block-list" });
    dayContexts.forEach(function (context) {
      list.appendChild(renderBlockRow(context, {
        showProject: true,
        showEdited: true,
        onCheck: function (done) { toggleDone(context, done, "[data-focus='check:" + context.key + "']"); },
        onEdit: function (target) {
          if (ui.editingKey === target.key) return; // 이미 열려 있으면 다시 눌러도 무시한다(spec 6-7)
          ui.editingKey = target.key;
          renderHome();
          focusLater("[data-edit-date]", byId("day-panel"));
        },
        onSave: function (target, date, amount) {
          updateProjectBlocks(target.projectId, function (blocks) {
            return applyEdit(blocks, target, date, amount, true);
          });
          ui.editingKey = null;
          renderHome("[data-focus='edit:" + target.key + "']");
          if (!document.activeElement || document.activeElement === document.body) {
            focusLater("#day-panel-title", byId("day-panel"));
          }
        },
        onCancel: function (target) {
          ui.editingKey = null;
          renderHome("[data-focus='edit:" + target.key + "']");
        },
      }));
    });
    panel.appendChild(list);
  }

  // ---------- 밀린 일 ----------

  function renderOverdue(contexts, today) {
    const section = byId("overdue");
    clear(section);
    const overdue = contexts
      .filter(function (context) { return !context.block.done && S.diffDays(context.block.date, today) > 0; })
      .sort(function (a, b) { return a.block.date < b.block.date ? -1 : a.block.date > b.block.date ? 1 : 0; });
    section.hidden = overdue.length === 0;
    if (!overdue.length) {
      ui.overdueOpen = null;
      return;
    }

    section.appendChild(el("div", { class: "card-head" }, [
      el("h3", { id: "overdue-title", tabindex: "-1", text: "밀린 일 (" + overdue.length + ")" }),
      el("span", { class: "chip chip-white", text: "부담 갖지 마세요" }),
    ]));
    section.appendChild(el("p", { class: "lead", text: "오늘 전에 끝내지 못한 일이에요. 어떻게 할지 골라 주세요." }));

    const list = el("ul", { class: "block-list" });
    overdue.forEach(function (context) {
      const item = renderBlockRow(context, {
        showProject: true,
        showOrigin: true,
        onCheck: function (done) { toggleDone(context, done, "#overdue-title"); },
      });
      item.appendChild(renderOverdueActions(context, today));
      list.appendChild(item);
    });
    section.appendChild(list);
  }

  function renderOverdueActions(context, today) {
    const open = ui.overdueOpen && ui.overdueOpen.key === context.key ? ui.overdueOpen : null;
    const check = S.checkSplittable(context.block, context.deadline, today);

    const moveButton = el("button", {
      type: "button",
      class: "btn btn-secondary",
      text: "다른 날로 옮기기",
      "data-focus": "move:" + context.key,
      onclick: function () {
        ui.overdueOpen = { key: context.key, mode: "move", date: today };
        renderHome();
        focusLater("[data-overdue-first]", byId("overdue"));
      },
    });
    const splitButton = el("button", {
      type: "button",
      class: "btn btn-secondary",
      text: "분할하기",
      disabled: !check.ok,
      "data-focus": "split:" + context.key,
      onclick: function () {
        ui.overdueOpen = {
          key: context.key,
          mode: "split",
          pieces: S.proposeSplit(context.block, context.deadline, today),
        };
        renderHome();
        focusLater("[data-overdue-first]", byId("overdue"));
      },
    });

    const wrapper = el("div", {}, [
      el("div", { class: "row-actions" }, [moveButton, splitButton]),
      check.ok ? null : el("p", { class: "reason", text: check.reason }),
    ]);

    if (open && open.mode === "move") wrapper.appendChild(renderMovePanel(context, today));
    if (open && open.mode === "split" && open.pieces) wrapper.appendChild(renderSplitPanel(context, open));
    return wrapper;
  }

  function closeOverdue(context, focusKind) {
    ui.overdueOpen = null;
    renderHome("[data-focus='" + focusKind + ":" + context.key + "']");
    if (!document.activeElement || document.activeElement === document.body) {
      focusLater("#overdue-title", byId("screen-home"));
      focusLater("#day-panel-title", byId("screen-home"));
    }
  }

  function renderMovePanel(context, today) {
    const input = el("input", {
      class: "input",
      type: "date",
      id: "move-date",
      value: ui.overdueOpen.date,
      min: today,
      "data-overdue-first": "1",
    });
    const error = el("p", { class: "error", role: "alert" });
    const submit = el("button", {
      type: "button",
      class: "btn btn-primary",
      text: "옮기기",
      onclick: function () {
        const date = input.value;
        if (!S.isValidDate(date) || date < today) {
          error.textContent = "오늘 이후의 날짜를 골라 주세요";
          return;
        }
        updateProjectBlocks(context.projectId, function (blocks) {
          return S.moveBlock(blocks, context.block.id, date, true);
        });
        ui.selected = date;
        const parts = splitDate(date);
        ui.homeMonth = { year: parts.year, month: parts.month };
        ui.overdueOpen = null;
        renderHome("#day-panel-title");
      },
    });
    const cancel = el("button", {
      type: "button",
      class: "btn btn-secondary",
      text: "취소",
      onclick: function () { closeOverdue(context, "move"); },
    });
    return el("div", { class: "panel" }, [
      el("div", { class: "panel-row" }, [el("label", { for: "move-date", text: "옮길 날짜" }), input]),
      error,
      el("div", { class: "panel-actions" }, [submit, cancel]),
    ]);
  }

  function renderSplitPanel(context, open) {
    const unit = context.task.unit || DEFAULT_UNIT;
    const sum = el("p", { class: "sum", "aria-live": "polite" });
    const submit = el("button", { type: "button", class: "btn btn-primary", text: "이대로 분할하기" });

    function refresh() {
      const total = open.pieces.reduce(function (acc, piece) { return acc + (Number.isFinite(piece.amount) ? piece.amount : 0); }, 0);
      const valid = S.isSplitValid(context.block, open.pieces);
      sum.textContent = "합계 " + total + " / " + context.block.amount + unit + (valid ? "" : " (합이 같아야 분할할 수 있어요)");
      sum.classList.toggle("is-bad", !valid);
      submit.disabled = !valid;
    }

    const rows = open.pieces.map(function (piece, index) {
      const id = "split-" + index;
      const input = el("input", {
        class: "input",
        type: "number",
        id: id,
        min: "0",
        step: "1",
        value: String(piece.amount),
        style: "max-width:96px",
        "data-overdue-first": index === 0 ? "1" : false,
        oninput: function (event) {
          const raw = event.target.value;
          piece.amount = raw === "" ? NaN : Number(raw);
          refresh();
        },
      });
      return el("div", { class: "panel-row" }, [
        el("label", { for: id, text: formatDay(piece.date) }),
        input,
        el("span", { text: unit }),
      ]);
    });

    submit.addEventListener("click", function () {
      if (!S.isSplitValid(context.block, open.pieces)) return;
      let firstDate = open.pieces.find(function (piece) { return piece.amount > 0; });
      updateProjectBlocks(context.projectId, function (blocks) {
        return S.applySplit(blocks, context.block.id, open.pieces);
      });
      if (firstDate) {
        ui.selected = firstDate.date;
        const parts = splitDate(firstDate.date);
        ui.homeMonth = { year: parts.year, month: parts.month };
      }
      ui.overdueOpen = null;
      renderHome("#day-panel-title");
    });

    const cancel = el("button", {
      type: "button",
      class: "btn btn-secondary",
      text: "취소",
      onclick: function () { closeOverdue(context, "split"); },
    });

    refresh();
    return el("div", { class: "panel" }, [
      el("p", { class: "sub", text: "남은 날짜에 이렇게 나눴어요. 수정할 수 있어요." }),
    ].concat(rows, [sum, el("div", { class: "panel-actions" }, [submit, cancel])]));
  }

  // ---------- 프로젝트 목록 ----------

  function renderProjects() {
    const section = byId("project-list");
    clear(section);
    section.hidden = state.projects.length === 0;
    if (!state.projects.length) return;

    section.appendChild(el("div", { class: "projects-head" }, [
      el("h3", { id: "projects-title", text: "진행 중인 프로젝트" }),
      el("span", { class: "count", text: "총 " + state.projects.length + "개" }),
    ]));

    state.projects.forEach(function (project, index) {
      const total = project.plan.blocks.length;
      const done = project.plan.blocks.filter(function (block) { return block.done; }).length;
      const icon = el("span", { class: "project-icon" }, [svgUse("icon-calendar", 20)]);
      icon.style.background = colorOf(index);

      section.appendChild(el("div", { class: "project-card" }, [
        el("div", { class: "project-main" }, [
          icon,
          el("div", {}, [
            el("div", { class: "project-name", text: project.name }),
            el("div", { class: "project-meta" }, [
              "끝나는 날 " + formatDay(project.settings.finalDeadline) + " · ",
              el("strong", { text: done + "/" + total + " 완료" }),
            ]),
          ]),
        ]),
        el("button", {
          type: "button",
          class: "link",
          text: "삭제",
          "aria-label": project.name + " 삭제",
          "data-focus": "delete:" + project.id,
          onclick: function () { deleteProject(project); },
        }),
      ]));
    });
  }

  function deleteProject(project) {
    confirmDialog("'" + project.name + "' 프로젝트의 일정이 지워져요. 삭제할까요?", "삭제").then(function (ok) {
      if (!ok) return;
      state.projects = state.projects.filter(function (item) { return item.id !== project.id; });
      ui.editingKey = null;
      ui.overdueOpen = null;
      persist();
      renderHome("#day-panel-title");
    });
  }

  // ---------- 확인 창 ----------

  function confirmDialog(message, okLabel, cancelLabel) {
    const dialog = byId("dialog");
    const opener = document.activeElement;
    byId("dialog-message").textContent = message;
    byId("dialog-ok").textContent = okLabel;
    byId("dialog-cancel").textContent = cancelLabel || "취소";
    return new Promise(function (resolve) {
      function finish(result) {
        byId("dialog-ok").removeEventListener("click", onOk);
        byId("dialog-cancel").removeEventListener("click", onCancel);
        dialog.removeEventListener("cancel", onCancel);
        dialog.close();
        if (opener && opener.isConnected) opener.focus();
        resolve(result);
      }
      function onOk() { finish(true); }
      function onCancel(event) {
        if (event && event.preventDefault) event.preventDefault();
        finish(false);
      }
      byId("dialog-ok").addEventListener("click", onOk);
      byId("dialog-cancel").addEventListener("click", onCancel);
      dialog.addEventListener("cancel", onCancel);
      dialog.showModal();
      byId("dialog-cancel").focus();
    });
  }

  // ---------- 입력 화면 ----------

  function ensureDraft() {
    if (!state.draft) {
      state.draft = { name: "", lines: [{ title: "", amount: "", unit: "", deadline: "" }], finalDeadline: "" };
    }
    return state.draft;
  }

  function isBlankLine(line) {
    return !line.title.trim() && !line.amount.trim() && !line.unit.trim();
  }

  // spec 4-3: 줄의 오류를 계산한다. 세 칸이 모두 비면 빈 줄이라 무시한다
  function checkLine(line) {
    if (isBlankLine(line)) return { blank: true, title: "", amount: "" };
    const result = { blank: false, title: "", amount: "" };
    if (!line.title.trim()) result.title = "일 이름을 적어 주세요";
    const amount = line.amount.trim();
    if (!/^\d+$/.test(amount) || Number(amount) < 1 || Number(amount) > MAX_AMOUNT) {
      result.amount = "분량은 1 이상의 숫자로 적어 주세요";
    }
    return result;
  }

  function checkFinalDeadline(value) {
    if (!value) return { ok: false, message: "" };
    const today = getToday();
    if (!S.isValidDate(value) || value < today || S.diffDays(today, value) > S.MAX_DEADLINE_DAYS) {
      return { ok: false, message: "마감일은 오늘부터 365일 안의 날짜로 골라 주세요" };
    }
    return { ok: true, message: "" };
  }

  function renderInput() {
    const draft = ensureDraft();
    const today = getToday();
    byId("project-name").value = draft.name;
    const deadline = byId("final-deadline");
    deadline.min = today;
    deadline.max = S.addDays(today, S.MAX_DEADLINE_DAYS);
    deadline.value = draft.finalDeadline;
    ui.touched = {};
    byId("make-plan-error").textContent = "";
    renderLines();
    refreshInputView();
  }

  function renderLines(focusIndex, focusField) {
    const draft = state.draft;
    const container = byId("lines");
    clear(container);
    draft.lines.forEach(function (line, index) {
      const number = index + 1;
      const titleError = el("p", { class: "error", id: "line-" + index + "-title-error" });
      const amountError = el("p", { class: "error", id: "line-" + index + "-amount-error" });
      const titleInput = el("input", {
        class: "input line-title",
        type: "text",
        maxlength: String(MAX_TITLE_LENGTH),
        placeholder: "예: 문제집 풀기",
        autocomplete: "off",
        value: line.title,
        "aria-label": number + "번째 줄 일 이름",
        "aria-describedby": titleError.id,
        "data-line": String(index),
        "data-field": "title",
      });
      const amountInput = el("input", {
        class: "input",
        type: "text",
        inputmode: "numeric",
        maxlength: "6",
        placeholder: "분량",
        autocomplete: "off",
        value: line.amount,
        "aria-label": number + "번째 줄 분량",
        "aria-describedby": amountError.id,
        "data-line": String(index),
        "data-field": "amount",
      });
      const unitInput = el("input", {
        class: "input",
        type: "text",
        maxlength: String(MAX_UNIT_LENGTH),
        placeholder: "단위",
        autocomplete: "off",
        value: line.unit,
        "aria-label": number + "번째 줄 단위",
        "data-line": String(index),
        "data-field": "unit",
      });
      const remove = el("button", {
        type: "button",
        class: "link link-danger",
        text: "지우기",
        "aria-label": number + "번째 줄 지우기",
        "data-remove": String(index),
      });
      const deadlineInput = el("input", {
        class: "input",
        type: "date",
        min: getToday(),
        value: line.deadline,
        "aria-label": number + "번째 줄 이 일만의 마감일",
        "data-line": String(index),
        "data-field": "deadline",
      });

      container.appendChild(el("div", { class: "line", "data-row": String(index) }, [
        el("div", { class: "line-fields" }, [titleInput, amountInput, unitInput, remove]),
        titleError,
        amountError,
        el("details", {}, [
          el("summary", { text: "이 일만의 마감일(선택)" }),
          deadlineInput,
        ]),
      ]));
    });
    byId("add-line").disabled = draft.lines.length >= S.MAX_TASK_LINES;
    byId("lines-limit").hidden = draft.lines.length < S.MAX_TASK_LINES;

    if (focusIndex !== undefined) {
      focusLater('[data-line="' + focusIndex + '"][data-field="' + (focusField || "title") + '"]', container);
    }
  }

  // 오류 문구는 그 칸을 벗어난 뒤에 보인다(spec 4-3)
  function refreshInputView() {
    const draft = state.draft;
    let hasLine = false;
    let hasError = false;
    draft.lines.forEach(function (line, index) {
      const result = checkLine(line);
      if (!result.blank) hasLine = true;
      if (result.title || result.amount) hasError = true;
      const row = document.querySelector('[data-row="' + index + '"]');
      if (!row) return;
      const showTitle = result.title && ui.touched[index + ":title"];
      const showAmount = result.amount && ui.touched[index + ":amount"];
      byId("line-" + index + "-title-error").textContent = showTitle ? result.title : "";
      byId("line-" + index + "-amount-error").textContent = showAmount ? result.amount : "";
      row.classList.toggle("has-error", Boolean(showTitle || showAmount));
      row.querySelector('[data-field="title"]').setAttribute("aria-invalid", showTitle ? "true" : "false");
      row.querySelector('[data-field="amount"]').setAttribute("aria-invalid", showAmount ? "true" : "false");
    });

    const deadline = checkFinalDeadline(draft.finalDeadline);
    const deadlineInput = byId("final-deadline");
    const showDeadlineError = deadline.message && ui.touched.deadline;
    byId("final-deadline-error").textContent = showDeadlineError ? deadline.message : "";
    deadlineInput.setAttribute("aria-invalid", showDeadlineError ? "true" : "false");

    const canSubmit = hasLine && !hasError && deadline.ok;
    byId("make-plan").disabled = !canSubmit;
    byId("make-plan-hint").hidden = canSubmit;
  }

  function bindInputEvents() {
    byId("project-name").addEventListener("input", function (event) {
      ensureDraft().name = event.target.value;
      persist();
    });

    const lines = byId("lines");
    lines.addEventListener("input", function (event) {
      const target = event.target;
      const index = target.getAttribute("data-line");
      if (index === null) return;
      state.draft.lines[Number(index)][target.getAttribute("data-field")] = target.value;
      persist();
      refreshInputView();
    });
    lines.addEventListener("focusout", function (event) {
      const index = event.target.getAttribute("data-line");
      const field = event.target.getAttribute("data-field");
      if (index === null || (field !== "title" && field !== "amount")) return;
      ui.touched[index + ":" + field] = true;
      refreshInputView();
    });
    lines.addEventListener("click", function (event) {
      const index = event.target.getAttribute("data-remove");
      if (index === null) return;
      const position = Number(index);
      const draft = state.draft;
      if (draft.lines.length === 1) {
        // 줄이 하나뿐이면 줄을 없애지 않고 세 칸을 비운다(spec 4-2)
        draft.lines[0] = { title: "", amount: "", unit: "", deadline: "" };
        ui.touched = {};
        persist();
        renderLines(0, "title");
      } else {
        draft.lines.splice(position, 1);
        ui.touched = {};
        persist();
        // 위쪽 줄의 '지우기' 자리로 초점을 옮긴다(spec 6-4)
        renderLines();
        focusLater('[data-remove="' + Math.max(0, position - 1) + '"]', lines);
      }
      refreshInputView();
    });

    byId("add-line").addEventListener("click", function () {
      const draft = state.draft;
      if (draft.lines.length >= S.MAX_TASK_LINES) return;
      draft.lines.push({ title: "", amount: "", unit: "", deadline: "" });
      persist();
      renderLines(draft.lines.length - 1, "title");
      byId("lines-announce").textContent = draft.lines.length + "번째 줄이 추가됐어요";
      refreshInputView();
    });

    const deadline = byId("final-deadline");
    deadline.addEventListener("input", function (event) {
      state.draft.finalDeadline = event.target.value;
      persist();
      refreshInputView();
    });
    deadline.addEventListener("blur", function () {
      ui.touched.deadline = true;
      refreshInputView();
    });

    byId("make-plan").addEventListener("click", makePreview);
  }

  // ---------- 미리보기 ----------

  function makePreview() {
    const draft = state.draft;
    const today = getToday();
    const error = byId("make-plan-error");
    error.textContent = "";
    try {
      const tasks = [];
      draft.lines.forEach(function (line) {
        if (isBlankLine(line)) return;
        tasks.push({
          id: "t" + (tasks.length + 1),
          title: line.title.trim(),
          amount: Number(line.amount.trim()),
          unit: line.unit.trim() || DEFAULT_UNIT,
          deadline: line.deadline || "",
        });
      });
      const plan = S.buildPlan(tasks, draft.finalDeadline, today);
      ui.previewPlan = plan;
      ui.previewTasks = tasks;
      ui.previewFinalDeadline = draft.finalDeadline;
      ui.previewName = draft.name.trim() || "프로젝트 " + (state.projects.length + 1);
    } catch (exception) {
      error.textContent = "일정을 만들지 못했어요. 입력을 확인해 주세요";
      return;
    }
    ui.previewOriginal = JSON.stringify(ui.previewPlan.blocks);
    const parts = splitDate(today);
    ui.previewMonth = { year: parts.year, month: parts.month };
    ui.previewSelected = null;
    ui.editingKey = null;
    showScreen("preview");
    renderPreview();
  }

  function previewDirty() {
    return JSON.stringify(ui.previewPlan.blocks) !== ui.previewOriginal;
  }

  function renderPreview(focusSelector) {
    const today = getToday();
    const contexts = listPreviewContexts();
    const dates = contexts.map(function (context) { return context.block.date; }).sort();
    const last = dates.length ? dates[dates.length - 1] : ui.previewPlan.startDate;

    byId("preview-desc").textContent = ui.previewName + " · " + formatDay(ui.previewPlan.startDate)
      + "부터 " + formatDay(last) + "까지 나눈 일정이에요. 수정할 곳이 있으면 수정한 뒤 확정해 주세요.";

    renderCalendar(byId("preview-calendar"), {
      year: ui.previewMonth.year,
      month: ui.previewMonth.month,
      contexts: contexts,
      selected: ui.previewSelected,
      today: today,
      prefix: "p-",
      onMonth: function (delta, focus) {
        ui.previewMonth = S.shiftMonth(ui.previewMonth.year, ui.previewMonth.month, delta);
        renderPreview("[data-focus='" + focus + "']");
      },
      onSelect: function (date, focus) {
        ui.previewSelected = date;
        const hasItems = contexts.some(function (context) { return context.block.date === date; });
        byId("preview-day-note").textContent = hasItems ? "" : formatDay(date) + "은 일정이 없어요";
        renderPreview("[data-focus='" + focus + "']");
        if (hasItems) {
          const group = document.querySelector('[data-group="' + date + '"] h3');
          if (group) {
            group.scrollIntoView({ block: "nearest" });
          }
        }
      },
    });

    const list = byId("preview-list");
    clear(list);
    dates.filter(function (date, index) { return dates.indexOf(date) === index; }).forEach(function (date) {
      const group = el("section", {
        class: "day-group" + (date === today ? " is-today" : ""),
        "data-group": date,
      }, [
        el("h3", { tabindex: "-1" }, [formatDay(date), date === today ? el("span", { class: "chip", text: "오늘" }) : null]),
      ]);
      const rows = el("ul", { class: "block-list" });
      contexts.filter(function (context) { return context.block.date === date; }).forEach(function (context) {
        rows.appendChild(renderBlockRow(context, {
          showProject: false,
          showEdited: false,
          onEdit: function (target) {
            if (ui.editingKey === target.key) return;
            ui.editingKey = target.key;
            renderPreview();
            focusLater("[data-edit-date]", byId("preview-list"));
          },
          onSave: function (target, newDate, amount) {
            ui.previewPlan = Object.assign({}, ui.previewPlan, {
              blocks: applyEdit(ui.previewPlan.blocks, target, newDate, amount, false),
            });
            ui.editingKey = null;
            renderPreview("[data-focus='edit:" + target.key + "']");
          },
          onCancel: function (target) {
            ui.editingKey = null;
            renderPreview("[data-focus='edit:" + target.key + "']");
          },
        }));
      });
      group.appendChild(rows);
      list.appendChild(group);
    });

    if (focusSelector) focusLater(focusSelector, byId("screen-preview"));
  }

  // 확정하면 프로젝트 목록에 더하고 홈을 연다. 확인 창은 없다(spec 6-5)
  function confirmPlan() {
    const today = getToday();
    const ids = state.projects.map(function (project) { return Number(project.id.slice(1)) || 0; });
    const nextId = "p" + (Math.max(0, Math.max.apply(null, ids.concat([0]))) + 1);
    state.projects.push({
      id: nextId,
      name: ui.previewName,
      tasks: ui.previewTasks,
      settings: { finalDeadline: ui.previewFinalDeadline },
      plan: { status: "confirmed", startDate: ui.previewPlan.startDate, blocks: ui.previewPlan.blocks },
    });
    state.draft = null;
    persist();
    // 확정 직후에는 프로젝트의 시작일이 있는 달이 보이고 선택한 날은 오늘이다(spec 6-3)
    const startParts = splitDate(ui.previewPlan.startDate);
    ui.homeMonth = { year: startParts.year, month: startParts.month };
    ui.selected = today;
    ui.previewPlan = null;
    ui.editingKey = null;
    showScreen("home");
    renderHome();
  }

  function goBackToInput(event) {
    event.preventDefault();
    const go = function () {
      ui.editingKey = null;
      showScreen("input");
      renderInput();
    };
    if (previewDirty()) {
      confirmDialog("수정한 내용이 사라져요. 입력 화면으로 갈까요?", "입력 화면으로").then(function (ok) {
        if (ok) go();
      });
    } else {
      go();
    }
  }

  // ---------- 시작 ----------

  function goHome(event) {
    event.preventDefault();
    ui.editingKey = null;
    ui.overdueOpen = null;
    ui.selected = getToday();
    showScreen("home");
    renderHome();
  }

  function bindEvents() {
    byId("add-project").addEventListener("click", function () {
      ensureDraft();
      persist();
      showScreen("input");
      renderInput();
    });
    document.querySelectorAll("[data-go='home']").forEach(function (link) {
      link.addEventListener("click", goHome);
    });
    byId("back-to-input").addEventListener("click", goBackToInput);
    byId("confirm-plan").addEventListener("click", confirmPlan);
    bindInputEvents();
  }

  function start() {
    const loaded = loadState();
    state = loaded.state;
    storageWorks = loaded.canSave;
    setNotice(loaded.notice);
    if (loaded.canSave) persist(false);
    if (loaded.notice) setNotice(loaded.notice);
    bindEvents();
    showScreen("home");
    // 첫 화면에서는 제목으로 초점을 옮기지 않고 그대로 둔다
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    renderHome();
    if (Backup.enabled) {
      byId("save-note").textContent = "입력한 내용은 이 기기의 브라우저에 저장되고, 백업을 위해 서버에도 저장돼요.";
    }
    syncOnStart();
  }

  start();
})();
