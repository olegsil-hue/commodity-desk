function answerCommand(text) {
  const lower = String(text || "").trim().toLowerCase().replaceAll("ё", "е");
  if (!lower) return "Напишите команду.";
  if (lower === "пауза" || lower === "стоп") return "Пауза. В 9:00 новые заявки не ставлю. Уже открытое закрою по цели или стопу.";
  if (lower === "продолжи" || lower === "продолжить" || lower === "работай") return "В 9:00 снова торгую. Сравню нефть с бумагами из учёбы и куплю одну самую сильную.";
  if (lower.includes("только нефт")) return "Принял. С 9:00 смотрю только нефть. Куплю контракт, только если день от +0,25% и сам контракт от +0,3%.";
  if (lower.includes("вся книг") || lower.includes("все бумаг")) return "Принял. С 9:00 снова сравниваю всю книгу и беру самую сильную идею, не обязательно нефть.";
  if (lower.includes("не шорт")) return "Принял. Шорт нефти больше не открываю.";
  if (lower.includes("шорт") && lower.includes("нефт")) return "Принял. Шорт нефти снова можно, но только если он сильнее других идей и день уже в минусе.";
  if (/закр(ой|ыть)\s+вс/.test(lower) || /(?:закр(?:ой|ыть)|продай)\s+/.test(lower)) {
    return "Принял. Закрою на следующем шаге бота, он начинается около 8:55. Если сессия ещё закрыта, заявка уйдёт, когда биржа примет её.";
  }
  if (lower.includes("уч")) return "Учусь сам по открытым профилям Пульса: портфель от 10 млн ₽ и доход выше 20% за год. В 9:00 сравню их бумаги с нефтью и куплю ту, что сильнее. Чужую сделку не копирую.";
  return "В 9:00 куплю одну самую сильную бумагу. Нефть беру, только если её ход больше, чем у акций, и свободно не меньше 20 000 ₽. Напишите: пауза, продолжи, закрой BRV6, только нефть, вся книга, не шорти нефть.";
}

function controlPatch(text) {
  const lower = String(text || "").trim().toLowerCase().replaceAll("ё", "е");
  if (lower === "пауза" || lower === "стоп") return { enabled: false };
  if (lower === "продолжи" || lower === "продолжить" || lower === "работай") return { enabled: true };
  if (lower.includes("только нефт")) return { book: "oil" };
  if (lower.includes("вся книг") || lower.includes("все бумаг")) return { book: "all" };
  if (lower.includes("не шорт")) return { allowOilShort: false };
  if (lower.includes("шорт") && lower.includes("нефт")) return { allowOilShort: true };
  return null;
}

function needsExecution(text) {
  const lower = String(text || "").trim().toLowerCase().replaceAll("ё", "е");
  return /закр(ой|ыть)\s+вс/.test(lower) || /(?:закр(?:ой|ыть)|продай)\s+/.test(lower);
}

module.exports = { answerCommand, controlPatch, needsExecution };
