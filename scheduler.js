// 계산만 한다. 화면, 저장소, 현재 시각을 직접 읽지 않고 오늘 날짜는 입력으로 받는다.
(function (root) {
  // 한도 값은 spec 4장의 입력 규칙을 따른다
  const MAX_PROJECTS = 10;
  const MAX_TASK_LINES = 50;
  const MAX_DEADLINE_DAYS = 365;
  // 시작일과 마감일을 모두 세므로 365일 뒤 마감이면 366일이다(spec 5-1)
  const MAX_SPAN_DAYS = MAX_DEADLINE_DAYS + 1;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

  // 날짜는 모두 UTC 기준으로 다룬다. 시간대와 서머타임이 계산에 끼어들지 않게 하려는 것이다(spec 4-1)
  function parseDate(text) {
    const match = DATE_PATTERN.exec(text);
    if (!match) return NaN;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const time = Date.UTC(year, month - 1, day);
    const date = new Date(time);
    // 2월 30일처럼 넘치는 날짜가 다음 달로 조용히 바뀌는 것을 막는다
    const isReal = date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
    return isReal ? time : NaN;
  }

  function isValidDate(text) {
    return typeof text === "string" && !Number.isNaN(parseDate(text));
  }

  function formatDate(time) {
    const date = new Date(time);
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return date.getUTCFullYear() + "-" + month + "-" + day;
  }

  function addDays(text, days) {
    return formatDate(parseDate(text) + days * MS_PER_DAY);
  }

  // to - from. 같은 날이면 0
  function diffDays(from, to) {
    return Math.round((parseDate(to) - parseDate(from)) / MS_PER_DAY);
  }

  // 0(일)~6(토). 달력이 일요일부터 시작하므로 UTC 요일을 그대로 쓴다(spec 6-6)
  function getWeekday(text) {
    return new Date(parseDate(text)).getUTCDay();
  }

  function shiftMonth(year, month, delta) {
    const index = year * 12 + (month - 1) + delta;
    return { year: Math.floor(index / 12), month: (index % 12) + 1 };
  }

  // spec 6-6: 한 달을 7열 표로 그릴 날짜 목록. 앞뒤는 이웃 달 날짜로 채우고 inMonth로 구분한다.
  function getMonthCells(year, month) {
    const first = formatDate(Date.UTC(year, month - 1, 1));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const offset = getWeekday(first);
    const total = Math.ceil((offset + daysInMonth) / 7) * 7;
    const cells = [];
    for (let index = 0; index < total; index += 1) {
      const date = addDays(first, index - offset);
      const dayOfMonth = index - offset + 1;
      cells.push({ date: date, inMonth: dayOfMonth >= 1 && dayOfMonth <= daysInMonth });
    }
    return cells;
  }

  // spec 5-2: 분량을 쓸 수 있는 날에 고르게 나누고, 남는 분량은 앞날에 놓는다.
  // 일찍 시작하는 쪽이 밀릴 위험을 줄이기 때문이다.
  function splitEvenly(amount, days) {
    const share = Math.floor(amount / days);
    const rest = amount % days;
    const result = [];
    for (let index = 0; index < days; index += 1) {
      result.push(index < rest ? share + 1 : share);
    }
    return result;
  }

  // spec 5-1: 일마다의 마감일이 시작일 이후(당일 포함)이면 그 날짜, 아니면 전체 마감일
  function resolveDeadline(task, finalDeadline, startDate) {
    const own = task.deadline;
    if (isValidDate(own) && diffDays(startDate, own) >= 0) return own;
    return finalDeadline;
  }

  // spec 5-3: 블록 날짜가 일의 마감일보다 늦으면 넘긴 날수, 아니면 0
  function countExceededDays(date, deadline) {
    return Math.max(0, diffDays(deadline, date));
  }

  // spec 5-2: 프로젝트의 일과 마감일로 날짜별 블록을 만든다
  function buildPlan(tasks, finalDeadline, startDate) {
    const blocks = [];
    tasks.forEach(function (task) {
      if (!(task.amount >= 1)) return; // 분량 0인 일은 블록 없이 넘긴다(spec 5-7)
      const deadline = resolveDeadline(task, finalDeadline, startDate);
      const days = Math.min(MAX_SPAN_DAYS, Math.max(1, diffDays(startDate, deadline) + 1));
      splitEvenly(task.amount, days).forEach(function (amount, index) {
        if (amount === 0) return;
        const date = addDays(startDate, index);
        blocks.push({
          id: task.id + "_" + date,
          taskId: task.id,
          date: date,
          amount: amount,
          done: false,
          edited: false,
        });
      });
    });
    return { status: "draft", startDate: startDate, blocks: blocks };
  }

  // 블록 id는 프로젝트 안에서만 유일하면 된다. 겹치면 _2, _3을 붙인다(spec 4-1)
  function makeBlockId(blocks, taskId, date) {
    const base = taskId + "_" + date;
    const taken = new Set(blocks.map(function (block) { return block.id; }));
    if (!taken.has(base)) return base;
    let count = 2;
    while (taken.has(base + "_" + count)) count += 1;
    return base + "_" + count;
  }

  // 같은 일, 같은 날짜의 완료하지 않은 블록. 합칠 대상이다(spec 5-3)
  function findMergeTarget(blocks, taskId, date, exceptId) {
    return blocks.find(function (block) {
      return block.taskId === taskId && block.date === date
        && !block.done && block.id !== exceptId;
    });
  }

  // 조각 하나를 날짜에 놓는다. 합칠 블록이 있으면 분량을 더한다.
  // 입력 배열은 바꾸지 않고 새 배열을 돌려준다.
  function placeAmount(blocks, taskId, date, amount, edited) {
    const target = findMergeTarget(blocks, taskId, date, null);
    if (target) {
      return blocks.map(function (block) {
        if (block.id !== target.id) return block;
        return Object.assign({}, block, {
          amount: block.amount + amount,
          edited: block.edited || edited,
        });
      });
    }
    return blocks.concat([{
      id: makeBlockId(blocks, taskId, date),
      taskId: taskId,
      date: date,
      amount: amount,
      done: false,
      edited: edited,
    }]);
  }

  function removeBlock(blocks, blockId) {
    return blocks.filter(function (block) { return block.id !== blockId; });
  }

  function findBlock(blocks, blockId) {
    return blocks.find(function (block) { return block.id === blockId; });
  }

  // spec 5-3, 5-5: 블록을 다른 날짜로 옮긴다. 미리보기에서는 markEdited를 false로 불러
  // 처음 제안을 다듬는 과정에 '수정됨'이 붙지 않게 한다.
  function moveBlock(blocks, blockId, newDate, markEdited) {
    const block = findBlock(blocks, blockId);
    // 완료한 블록은 옮기지 않는다. 합칠 때 완료 여부가 섞이는 것을 막으려는 것이다
    if (!block || block.done || block.date === newDate) return blocks;
    const rest = removeBlock(blocks, blockId);
    return placeAmount(rest, block.taskId, newDate, block.amount, markEdited);
  }

  // spec 5-3: 분량을 고치면 일의 전체 분량도 같은 만큼 바뀐다. 분량은 1 이상의 정수다.
  function changeBlockAmount(blocks, blockId, newAmount, markEdited) {
    if (!Number.isInteger(newAmount) || newAmount < 1) return blocks;
    return blocks.map(function (block) {
      if (block.id !== blockId) return block;
      return Object.assign({}, block, {
        amount: newAmount,
        edited: block.edited || markEdited,
      });
    });
  }

  // spec 5-4: 오늘 몫과 밀린 일. 여러 프로젝트의 블록을 한 배열로 합쳐 넣는다.
  function findTodayBlocks(blocks, today) {
    return blocks.filter(function (block) { return block.date === today; });
  }

  function findOverdueBlocks(blocks, today) {
    return blocks.filter(function (block) {
      return !block.done && diffDays(block.date, today) > 0;
    });
  }

  function isTodayDone(blocks, today) {
    const todayBlocks = findTodayBlocks(blocks, today);
    return todayBlocks.length > 0 && todayBlocks.every(function (block) { return block.done; });
  }

  function isAllDone(blocks) {
    return blocks.length > 0 && blocks.every(function (block) { return block.done; });
  }

  // spec 5-6: 분할은 분량이 2 이상이고 오늘부터 마감일까지 이틀 이상일 때만 쓸 수 있다.
  // 쓸 수 없으면 이유를 함께 돌려줘 화면이 그대로 보여 줄 수 있게 한다.
  function checkSplittable(block, deadline, today) {
    if (block.amount < 2) {
      return { ok: false, reason: "분량이 1이라 더 나눌 수 없어요. 다른 날로 옮겨 주세요." };
    }
    const left = diffDays(today, deadline);
    if (left < 0) {
      return { ok: false, reason: "마감일이 지나서 나눌 날이 없어요. 다른 날로 옮겨 주세요." };
    }
    if (left < 1) {
      return { ok: false, reason: "나눌 수 있는 날이 하루뿐이에요. 다른 날로 옮겨 주세요." };
    }
    return { ok: true, days: Math.min(MAX_SPAN_DAYS, left + 1) };
  }

  // spec 5-6: 제안은 오늘부터 마감일까지의 날짜에 고르게 나눈 값이다
  function proposeSplit(block, deadline, today) {
    const check = checkSplittable(block, deadline, today);
    if (!check.ok) return null;
    return splitEvenly(block.amount, check.days).map(function (amount, index) {
      return { date: addDays(today, index), amount: amount };
    });
  }

  // 분량의 합이 원래 블록과 같을 때만 확정할 수 있다(spec 5-6)
  function isSplitValid(block, pieces) {
    const sum = pieces.reduce(function (total, piece) { return total + piece.amount; }, 0);
    const allWhole = pieces.every(function (piece) {
      return Number.isInteger(piece.amount) && piece.amount >= 0;
    });
    return allWhole && sum === block.amount;
  }

  // spec 5-6: 원래 블록을 빼고 조각을 날짜에 놓는다. 0은 그날을 건너뛴다.
  function applySplit(blocks, blockId, pieces) {
    const block = findBlock(blocks, blockId);
    if (!block || !isSplitValid(block, pieces)) return blocks;
    return pieces.reduce(function (result, piece) {
      if (piece.amount === 0) return result;
      return placeAmount(result, block.taskId, piece.date, piece.amount, true);
    }, removeBlock(blocks, blockId));
  }

  const api = {
    MAX_PROJECTS: MAX_PROJECTS,
    MAX_TASK_LINES: MAX_TASK_LINES,
    MAX_DEADLINE_DAYS: MAX_DEADLINE_DAYS,
    isValidDate: isValidDate,
    addDays: addDays,
    getWeekday: getWeekday,
    shiftMonth: shiftMonth,
    getMonthCells: getMonthCells,
    diffDays: diffDays,
    splitEvenly: splitEvenly,
    resolveDeadline: resolveDeadline,
    countExceededDays: countExceededDays,
    buildPlan: buildPlan,
    moveBlock: moveBlock,
    changeBlockAmount: changeBlockAmount,
    findTodayBlocks: findTodayBlocks,
    findOverdueBlocks: findOverdueBlocks,
    isTodayDone: isTodayDone,
    isAllDone: isAllDone,
    checkSplittable: checkSplittable,
    proposeSplit: proposeSplit,
    isSplitValid: isSplitValid,
    applySplit: applySplit,
  };

  // 브라우저와 노드 테스트에서 같은 파일을 쓰려고 두 방식으로 내보낸다
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.Scheduler = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
