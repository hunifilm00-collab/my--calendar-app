// 노드로 실행한다: node scheduler.test.js
// 기대값은 spec 12번의 손계산 사례에서 가져온다. 코드가 낸 값을 옮겨 적지 않는다.
const assert = require("assert");
const scheduler = require("./scheduler");

let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log("통과: " + name);
  } catch (error) {
    failed += 1;
    console.log("실패: " + name + " - " + error.message);
  }
}

// 블록을 '날짜:분량' 글자 목록으로 바꿔 한눈에 비교한다
function summarize(blocks) {
  return blocks
    .map(function (block) { return block.date.slice(5) + ":" + block.amount; })
    .sort();
}

function sumAmount(blocks) {
  return blocks.reduce(function (total, block) { return total + block.amount; }, 0);
}

// 사례 공통: 오늘 2026-10-12(월), 전체 마감일 2026-10-16(금), 쓸 수 있는 날 5일
const TODAY = "2026-10-12";
const FINAL = "2026-10-16";

function makePlan(tasks, finalDeadline, today) {
  return scheduler.buildPlan(tasks, finalDeadline || FINAL, today || TODAY);
}

check("한도 상수가 spec과 같아요", function () {
  assert.strictEqual(scheduler.MAX_PROJECTS, 10);
  assert.strictEqual(scheduler.MAX_TASK_LINES, 50);
  assert.strictEqual(scheduler.MAX_DEADLINE_DAYS, 365);
});

check("날짜 계산: 월 경계와 윤년을 넘어요", function () {
  assert.strictEqual(scheduler.addDays("2026-10-31", 1), "2026-11-01");
  assert.strictEqual(scheduler.addDays("2028-02-28", 1), "2028-02-29");
  assert.strictEqual(scheduler.diffDays("2026-10-12", "2026-10-16"), 4);
  assert.strictEqual(scheduler.isValidDate("2026-02-30"), false);
  assert.strictEqual(scheduler.isValidDate("2026-10-12"), true);
});

check("사례 1: 30쪽을 5일에 6쪽씩 나눠요", function () {
  const plan = makePlan([{ id: "t1", amount: 30 }]);
  assert.deepStrictEqual(summarize(plan.blocks), ["10-12:6", "10-13:6", "10-14:6", "10-15:6", "10-16:6"]);
});

check("사례 2: 3회는 앞의 3일에 1회씩, 뒤 2일은 비어요", function () {
  const plan = makePlan([{ id: "t1", amount: 3 }]);
  assert.deepStrictEqual(summarize(plan.blocks), ["10-12:1", "10-13:1", "10-14:1"]);
});

check("사례 3: 7개는 2, 2, 1, 1, 1로 나뉘고 합이 7이에요", function () {
  const plan = makePlan([{ id: "t1", amount: 7 }]);
  assert.deepStrictEqual(summarize(plan.blocks), ["10-12:2", "10-13:2", "10-14:1", "10-15:1", "10-16:1"]);
  assert.strictEqual(sumAmount(plan.blocks), 7);
});

check("사례 4: 일마다의 마감일(10-14)을 따라요", function () {
  const plan = makePlan([{ id: "t1", amount: 4, deadline: "2026-10-14" }]);
  assert.deepStrictEqual(summarize(plan.blocks), ["10-12:2", "10-13:1", "10-14:1"]);
});

check("사례 4 보충: 시작일 이전의 일별 마감일은 전체 마감일을 써요", function () {
  const plan = makePlan([{ id: "t1", amount: 5, deadline: "2026-10-01" }]);
  assert.strictEqual(plan.blocks.length, 5);
});

// 사례 5(줄 입력)는 화면 쪽 규칙이라 2단계에서 검증한다

// 사례 6, 7 공통: 오늘 10-14, 사례 1의 일정에서 12일 블록 6쪽이 밀렸다
const LATE_TODAY = "2026-10-14";

check("사례 6: 12일 블록을 15일로 옮기면 12쪽 한 블록이 되고 수정됨이 붙어요", function () {
  const plan = makePlan([{ id: "t1", amount: 30 }]);
  const moved = scheduler.moveBlock(plan.blocks, "t1_2026-10-12", "2026-10-15", true);
  assert.deepStrictEqual(summarize(moved), ["10-13:6", "10-14:6", "10-15:12", "10-16:6"]);
  assert.strictEqual(sumAmount(moved), 30);
  const merged = moved.find(function (block) { return block.date === "2026-10-15"; });
  assert.strictEqual(merged.edited, true);
  assert.strictEqual(plan.blocks.length, 5); // 원래 배열은 바뀌지 않아요
});

check("사례 6 보충: 미리보기에서 옮기면 수정됨이 붙지 않아요", function () {
  const plan = makePlan([{ id: "t1", amount: 30 }]);
  const moved = scheduler.moveBlock(plan.blocks, "t1_2026-10-12", "2026-10-15", false);
  assert.strictEqual(moved.some(function (block) { return block.edited; }), false);
});

check("사례 7: 6쪽을 14일부터 2, 2, 2로 나눠 각각 8쪽이 되고 모두 수정됨이에요", function () {
  const plan = makePlan([{ id: "t1", amount: 30 }]);
  const block = plan.blocks[0];
  const proposal = scheduler.proposeSplit(block, FINAL, LATE_TODAY);
  assert.deepStrictEqual(proposal, [
    { date: "2026-10-14", amount: 2 },
    { date: "2026-10-15", amount: 2 },
    { date: "2026-10-16", amount: 2 },
  ]);
  const result = scheduler.applySplit(plan.blocks, block.id, proposal);
  assert.deepStrictEqual(summarize(result), ["10-13:6", "10-14:8", "10-15:8", "10-16:8"]);
  const touched = result.filter(function (item) { return item.date >= "2026-10-14"; });
  assert.strictEqual(touched.every(function (item) { return item.edited; }), true);
  assert.strictEqual(sumAmount(result), 30);
});

check("사례 7 보충: 3, 2, 2로 고치면 합이 7이라 확정할 수 없어요", function () {
  const plan = makePlan([{ id: "t1", amount: 30 }]);
  const block = plan.blocks[0];
  const pieces = [
    { date: "2026-10-14", amount: 3 },
    { date: "2026-10-15", amount: 2 },
    { date: "2026-10-16", amount: 2 },
  ];
  assert.strictEqual(scheduler.isSplitValid(block, pieces), false);
  assert.strictEqual(scheduler.applySplit(plan.blocks, block.id, pieces), plan.blocks);
});

check("사례 7 보충: 0을 넣으면 그날은 건너뛰어요", function () {
  const plan = makePlan([{ id: "t1", amount: 30 }]);
  const block = plan.blocks[0];
  const pieces = [
    { date: "2026-10-14", amount: 0 },
    { date: "2026-10-15", amount: 3 },
    { date: "2026-10-16", amount: 3 },
  ];
  const result = scheduler.applySplit(plan.blocks, block.id, pieces);
  assert.deepStrictEqual(summarize(result), ["10-13:6", "10-14:6", "10-15:9", "10-16:9"]);
});

check("사례 8: 분량이 1이면 나눌 수 없고 이유가 나와요", function () {
  const block = { id: "t1_2026-10-12", taskId: "t1", date: "2026-10-12", amount: 1, done: false, edited: false };
  const check1 = scheduler.checkSplittable(block, FINAL, LATE_TODAY);
  assert.strictEqual(check1.ok, false);
  assert.ok(check1.reason.length > 0);
});

check("사례 8: 마감이 오늘이거나 지났으면 나눌 수 없어요", function () {
  const block = { id: "t1_2026-10-12", taskId: "t1", date: "2026-10-12", amount: 6, done: false, edited: false };
  assert.strictEqual(scheduler.checkSplittable(block, "2026-10-14", LATE_TODAY).ok, false);
  assert.strictEqual(scheduler.checkSplittable(block, "2026-10-13", LATE_TODAY).ok, false);
  assert.strictEqual(scheduler.proposeSplit(block, "2026-10-14", LATE_TODAY), null);
});

check("사례 9: 일이 없으면 블록이 0개예요", function () {
  assert.strictEqual(makePlan([]).blocks.length, 0);
});

check("사례 9: 분량이 0인 일만 있으면 블록이 0개예요", function () {
  assert.strictEqual(makePlan([{ id: "t1", amount: 0 }]).blocks.length, 0);
});

check("사례 9: 마감일이 오늘이면 5개가 오늘 한 블록이에요", function () {
  const plan = makePlan([{ id: "t1", amount: 5 }], TODAY, TODAY);
  assert.deepStrictEqual(summarize(plan.blocks), ["10-12:5"]);
});

check("사례 10: 오늘 몫과 밀린 일", function () {
  const blocks = [
    { id: "a", taskId: "t1", date: "2026-10-12", amount: 6, done: false, edited: false },
    { id: "b", taskId: "t1", date: "2026-10-13", amount: 6, done: true, edited: false },
    { id: "c", taskId: "t1", date: "2026-10-14", amount: 6, done: false, edited: false },
    { id: "d", taskId: "t2", date: "2026-10-14", amount: 2, done: false, edited: false },
  ];
  const overdue = scheduler.findOverdueBlocks(blocks, LATE_TODAY);
  assert.deepStrictEqual(overdue.map(function (block) { return block.id; }), ["a"]);
  assert.strictEqual(scheduler.findTodayBlocks(blocks, LATE_TODAY).length, 2);
  assert.strictEqual(scheduler.isTodayDone(blocks, LATE_TODAY), false);

  const checked = blocks.map(function (block) {
    return block.date === LATE_TODAY ? Object.assign({}, block, { done: true }) : block;
  });
  assert.strictEqual(scheduler.isTodayDone(checked, LATE_TODAY), true);
  // 오늘 몫을 마쳐도 12일 블록은 계속 밀린 일에 남아요
  assert.strictEqual(scheduler.findOverdueBlocks(checked, LATE_TODAY).length, 1);
  assert.strictEqual(scheduler.isAllDone(checked), false);
});

check("마감 초과 일수: 블록이 마감보다 늦은 날수를 세요", function () {
  assert.strictEqual(scheduler.countExceededDays("2026-10-17", "2026-10-16"), 1);
  assert.strictEqual(scheduler.countExceededDays("2026-10-16", "2026-10-16"), 0);
  assert.strictEqual(scheduler.countExceededDays("2026-10-14", "2026-10-16"), 0);
});

check("분량 고치기: 1 이상의 정수만 받아요", function () {
  const plan = makePlan([{ id: "t1", amount: 30 }]);
  const id = plan.blocks[0].id;
  assert.strictEqual(scheduler.changeBlockAmount(plan.blocks, id, 0, true), plan.blocks);
  assert.strictEqual(scheduler.changeBlockAmount(plan.blocks, id, 2.5, true), plan.blocks);
  const changed = scheduler.changeBlockAmount(plan.blocks, id, 9, true);
  assert.strictEqual(changed[0].amount, 9);
  assert.strictEqual(changed[0].edited, true);
});

check("달력: 2026년 10월은 목요일에 시작해 5주예요", function () {
  const cells = scheduler.getMonthCells(2026, 10);
  assert.strictEqual(cells.length, 35);
  assert.strictEqual(cells[0].date, "2026-09-27");
  assert.strictEqual(cells[0].inMonth, false);
  assert.strictEqual(cells[4].date, "2026-10-01");
  assert.strictEqual(cells[4].inMonth, true);
  assert.strictEqual(cells[34].date, "2026-10-31");
  assert.strictEqual(scheduler.getWeekday("2026-10-13"), 2); // 화요일
});

check("달력: 달 이동은 해를 넘겨요", function () {
  assert.deepStrictEqual(scheduler.shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepStrictEqual(scheduler.shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
});

check("분할 불가 문구: 마감이 지난 경우와 하루뿐인 경우가 달라요", function () {
  const block = { id: "a", taskId: "t1", date: "2026-10-12", amount: 6, done: false, edited: false };
  assert.ok(scheduler.checkSplittable(block, "2026-10-13", LATE_TODAY).reason.indexOf("지나서") >= 0);
  assert.ok(scheduler.checkSplittable(block, "2026-10-14", LATE_TODAY).reason.indexOf("하루뿐") >= 0);
});

process.exit(failed ? 1 : 0);
