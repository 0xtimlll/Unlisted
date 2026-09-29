# Unlisted — контекст для новой сессии

Приватный некастодиальный мост. Next.js static export на Cloudflare Pages, только desktop.
Вкладки: OFT (LayerZero), NTT (Wormhole), CCIP (Chainlink), Rescue. Мост определяется из адреса
токена, а не выбирается пользователем.

## Два правила, которые старше любой задачи

1. **Безопасность средств — приоритет №1.** Никаких unlimited approve. Никаких адресов протокольных
   контрактов из пользовательского ввода или внешних API в рантайме без сверки — только из
   закоммиченного конфига, проверенного on-chain.
2. **Ничего не выдумывать.** Адреса, ID, ABI, селекторы — только из первоисточников и с проверкой
   через RPC. Селектор, посчитанный по памяти, даёт `REVERT` на живом контракте и выглядит как
   «контракт не поддерживает функцию». Считать из сигнатуры: `toFunctionSelector('function eid()')`.

Не ломать то, что работает: существующие пути отправки OFT v2 / NTT / CCIP не переписывать без
необходимости, новое — отдельными модулями.

## Архитектура

**Реестр сетей** — `src/core/chains.ts`. `ChainDef` — размеченное объединение по `vm`
(`'evm' | 'svm'`). Всё, чему нужен `chainId` или wei, обязано сначала сузиться через `isEvm()`.
У каждой сети есть `feeCeiling` — намеренно щедрый потолок комиссии в наименьшей единице
(guard 21 не отказывает, а просит подтвердить сумму).

**Ядро** — `src/core/`: `probe.ts` (детект OFT), `plan.ts`, `guards.ts`, `recipient.ts`,
`quorum.ts` (кросс-проверка двух RPC), `options.ts`, `verify.ts`, `track.ts`, `decodeTx.ts`.

**Протокольные модули** — `src/protocols/`:

| Модуль | Что делает |
|---|---|
| `lz-v1/` | LayerZero v1 OFT: три wire-стандарта (`bytes`, `bytes32`, `bytes32_fee`), adapterParams, свой `selfcheck.ts`, 22 guard'а, `send.ts` — единственное место, где уходит `sendFrom` |
| `lz-risk/` | Индикатор риска маршрута: 8 проверок, 5 жёстких, 4 уровня. Ни одного write-примитива |
| `lz-rescue/` | Вкладка Rescue: четыре действия из белого списка, `keccak256(payload)` сверяется с on-chain хешем |
| `wormhole-ntt/` | NTT |
| `ccip/` | CCIP |
| `src/core/svm/` | Solana (на `@layerzerolabs/oft-v2-solana-sdk`) |

Таблицы, а не хардкод: `lz-v1/chains.json` (v1 chainId, endpoint, ULN, `v1Active` + причина),
`lz-risk/dvns.json` (614 DVN, 94 deprecated). Обе генерируются — см. ниже.

## Правила безопасности

**Белый список** — `scripts/check-whitelist.mjs`, часть `npm test`. Запрещено везде в `src/`:
`eval`, `new Function`, `dangerouslySetInnerHTML`, любые подписи сообщений (`signMessage`,
`signTypedData`, `personal_sign`, `permit`), `sendTransaction` / `sendRawTransaction` (сырой calldata),
`signAllTransactions`, ручная сборка Solana-инструкций, SPL-делегаты и `setAuthority`.

**Scoped-категории**: write-примитив разрешён только в своём модуле — `transfer` в `wormhole-ntt/`,
`ccipSend` в `ccip/`, `sendFrom` в `lz-v1/`, а `retryPayload` / `retryMessage` / `commitVerification` /
`lzReceive` — каждый только в `lz-rescue/`. Отдельно `SIMULATED_ONLY` (`nonblockingLzReceive`,
`lzReceive`): эти имена разрешены как `functionName` внутри `lz-risk/` ради `eth_call`, и сам модуль
отдельно проверяется на отсутствие любого write-примитива.

**Guard'ы** — `src/core/guards.ts`, 22 штуки, от `g1Chain` до `g22Risk`. Ключевые: `g11NoApprove`
(нет unlimited approve), `g15ExecutorGas`, `g19RecipientVm`, `g20SvmSend` (отказ, если svm-destination не опознан),
`g21FeeCeiling`, `g22Risk`.

**Независимая проверка получателя.** `selfCheck` каждого протокола **не переиспользует функции
кодирования** — это отдельный декодер, читающий адрес ровно так, как его прочтёт контракт на
destination. Для v1: у `bytes` длина обязана быть ровно 20 байт; у `bytes32` старшие 12 байт обязаны
быть нулями. Селектор в calldata обязан соответствовать обнаруженному стандарту, таблица селекторов
вычисляется из сигнатур. Несоответствие — блок, а не предупреждение. Перед подписью — `eth_call` ровно
той же транзакции; реверт → кнопка не показывается.

**Правила индикатора риска** (`lz-risk/risk.ts`). Проверки: `peers`, `path`, `config`, `delivery_sim`,
`adapter_liquidity`, `limits`, `history`, `recent_changes`. Жёсткие — `peers`, `path`, `delivery_sim`,
`adapter_liquidity`, `limits`. Уровни `BLOCKED | UNVERIFIED | CAUTION | OK`. Правила:

- **невыполненная проверка = серая «не проверено» с причиной**, никогда не зелёная галочка;
- у состояния есть разница между `skipped` (не применимо к маршруту) и `unchecked` (не удалось);
- если не выполнилась **жёсткая** проверка — итог не выше `UNVERIFIED`, полная сумма недоступна,
  и галочка/слово этого не обходят;
- `BLOCKED` не отправляет ничего, включая тестовую сумму;
- маршруты вне покрытия (Solana, NTT, CCIP, и любой будущий не-EVM vm) получают серый
  «индикатор не оценивает» автоматически — `riskCovers()` требует `vm === 'evm'` с обеих сторон;
- тестовый лимит per-token, дефолта нет: пока значение не введено, тестовая отправка недоступна.

DVN сравниваются **по id оператора, а не по адресу** — на двух сетях у одного оператора разные адреса,
и сравнение по адресу помечало каждый здоровый маршрут как сломанный.

## Команды

```
npm test                 # check:whitelist + unit — то, что должно проходить всегда
npm run test:unit
npm run test:integration # живые публичные RPC, не входит в npm test, бывает флейки
npm run typecheck
npm run lint
npm run build            # обязан проходить после каждого этапа
npm run check:whitelist
npm run audit
```

Генераторы таблиц (`gen:` перезаписывает, `check:` только сверяет — годится для CI):

```
npm run gen:lz-v1    / npm run check:lz-v1     # lz-v1/chains.json из metadata LayerZero + RPC
npm run gen:lz-dvns  / npm run check:lz-dvns   # lz-risk/dvns.json
npm run headers                                 # заголовки для Cloudflare
```

## Дальше читать

- [`docs/TODO.md`](docs/TODO.md) — известные проблемы, по которым сознательно не действовали:
  что не так, почему оставлено, что должно стать правдой, чтобы закрыть.
- [`docs/research/non-evm.md`](docs/research/non-evm.md) — разведка Tron / Aptos / Sui / TON
  (LayerZero, NTT, CCIP, форматы адресов, кошельки, реальные токены, риски, предлагаемый порядок).
  **Решено: не делаем, вернёмся при появлении конкретного токена.** Разведка остаётся как есть —
  это вход в тему, когда такой токен найдётся, а не план на ближайшее время.
