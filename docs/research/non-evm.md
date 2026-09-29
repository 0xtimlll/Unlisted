# Tron, Aptos, Sui, TON — разведка перед решением

Исследование от 2026-09-29. Код не писался, транзакции не отправлялись. Всё, что помечено «проверено»,
прочитано с mainnet или вычислено здесь; остальное — из первоисточников (metadata LayerZero,
OFT API, репозитории wormhole-foundation, директория Chainlink CCIP).

Это снимок на дату, а не план. Решение по нему принимает владелец проекта.

---

## Таблица

| | **Tron** | **Aptos** | **Sui** | **TON** |
|---|---|---|---|---|
| **LZ версии / eid** | v1 `420`, v2 `30420` | v1 `108`, v2 `30108` | только v2 `30378` | только v2 `30343` |
| **EndpointV2** | `0x0af59750d5db5460e5d89e268c474d5f7407c061` — `eid()` прочитан on-chain → `0x76d4` = 30420 ✓ | `0xe60045e20fc2c99e869c1c34a65b9291c020cd12a0d37a00a53ac1348af4f43c`, Move-модули | `0x31beaef889b08b9c3b37d19280fc1f8b75bae5b2de2410fc3120f403e9a36dac`, Move-пакет, 18 модулей | ключа `endpointV2` нет; `controller` `0x1eb2bbea3d8c0d42ff7fd60f0264c866c934bbff727526ca759e7374cae0c166` (живой, ~171 TON), плюс `ulnManager`, `allStorages`, `dvnProxy`, `executorProxy` |
| **NTT** | нет (сети нет в `chains.ts` Wormhole SDK) | нет (в NTT-репозитории только evm/solana/sui/xrpl) | impl `sui` есть, Wormhole chain 21 | нет |
| **CCIP** | селектор `1546563616611573945` (и `…946` для EVM-стороны), но **сети нет в mainnet-директории** | **живая**: селектор `4741433654826277614`, 14 лейнов в каждую сторону, router+TAR `0x20f808de…`, комиссия APT/LINK | селектор `17529533435026248318`, **в директории нет** | **живая**: селектор `16448340667252469081`, но всего 2 лейна, комиссия GRAM, router `EQDxL8F4t1RPjjBR45R3f6e60djNBUwWpI6wH3rV_8PJCLaw`, **tokenAdminRegistry пуст** |
| **Формат адреса** | base58check: `0x41` + 20 байт + 4 байта double-SHA256. В `bytes32` — те же 20 байт left-padded, как EVM | 32 байта hex, контрольной суммы нет | 32 байта hex, контрольной суммы нет | workchain + 32 байта. User-friendly = base64url `[flags][wc][32 байта][CRC16-CCITT]`. **LZ отбрасывает workchain**, кладёт только account id |
| **Кошелёк** | TronLink, `@tronweb3/tronwallet-adapter-react-hooks` 1.1.14 MIT (+ `tronweb` 6.5.1 MIT) | `@aptos-labs/wallet-adapter-react` 8.3.3 (+ `@aptos-labs/ts-sdk` 7.3.0) | `@mysten/dapp-kit` 1.1.17 (+ `@mysten/sui` 2.33.2) | `@tonconnect/ui-react` 3.0.2 (+ `@ton/ton` 16.3.0) |
| **Реальные OFT** | **4**: USDT0 (адаптер, peers 30101 + 30110), HARD (30101), WIF (30102/30110/30184), TRUMP (**peers пусты**) | **4**: APT (native adapter), USDe ×2, wBTC — у USDe-адаптера peer только 30101 | **0** | **4 адаптера**: ENA, USDe, USDT0, XAUT0 |
| **Сложность EVM → сеть** | низкая | низкая | — | средняя |
| **Сложность сеть → EVM** | высокая | средняя | — | высокая |

---

## Находки

### Sui закрывается

Двумя независимыми источниками. В `/v1/metadata/experiment/ofts/list` (369 записей токенов,
75 различных `chainKey`) у Sui **ноль** деплоев OFT. И в самом endpoint-пакете на Sui нет ни одного
модуля с `oft` в имени — только messaging-слой: `endpoint_quote`, `endpoint_send`, `endpoint_v2`,
`lz_compose`, `lz_receive`, `message_lib_*`, `messaging_*`, `oapp_registry`, `outbound_packet`,
`timeout`, `utils`. Мост есть, возить нечего.

Публичный JSON-RPC Sui объявлен deprecated; читается через GraphQL на
`https://graphql.mainnet.sui.io/graphql`.

### Tron читается существующим кодом, но не существующим клиентом

Все четыре OFT отвечают на штатный V2-интерфейс — `oftVersion()` возвращает interfaceId `0x02e49c2c`
(версия 0 у адаптера USDT0, 1 у остальных), плюс `token()`, `sharedDecimals()`, `peers(uint32)`,
`approvalRequired()`. То есть `src/core/abi.ts` менять не нужно, ABI совпадает.

Упирается в другое:

- **Multicall3 по каноническому адресу `0xcA11bde05977b3631167028862bE2a173976CA11` на Tron не
  задеплоен** (`eth_getCode` → пусто), а `probeOft` построен на нём;
- параллельные чтения TronGrid отдаёт с HTTP 429, нужно последовательно и с паузами.

Чтение идёт через `https://api.trongrid.io/jsonrpc`, `eth_chainId` → `0x2b6653dc` (728126428).

Отдельная мель: селекторы нельзя брать по памяти. В ходе разведки два выдуманных селектора дали
`REVERT opcode executed` на живых контрактах, и это выглядело как «контракт не поддерживает функцию».
Правильные, вычисленные из сигнатур: `oftVersion()` = `0x156a0d0f`, `approvalRequired()` = `0x9f68b964`,
`eid()` = `0x416ecebf`. Ровно тот же класс ошибки, что записан в памяти проекта как
«a failed read is not a missing function».

### Aptos отправляется без SDK

В модуле `oft` есть публичная entry-функция:

```
ENTRY send_withdraw(&signer, u32, vector<u8>, u64, u64, vector<u8>, vector<u8>, vector<u8>, u64, u64)
```

Кошелёк вызывает её напрямую — посредник не нужен. `quote_send` на USDe-адаптере живой (вернул
`285733697` октас). Есть и view-функции для всего, что нужно индикатору: `get_peer`, `shared_decimals`,
`token`, `debit_view`, `quote_oft`, `send_standards_supported` (→ `fungible_asset`).

Это важно, потому что **готового браузерного SDK отправки нет ни для одной из четырёх сетей**.
`@layerzerolabs/oft-move` 1.1.3 и `devtools-move` 2.0.0 — CLI для деплоя и вайринга, не отправка;
для Sui и Tron пакета нет вовсе. Единственный опубликованный send-SDK остаётся
`@layerzerolabs/oft-v2-solana-sdk`, на котором стоит нынешний Solana-путь.

### Кодирование получателя одинаковое во всех VM

Сам OFT-кодек от VM не зависит: `[send_to(32)][amount_sd(8)][compose_from(32)][compose_msg]`.
Различается только то, как destination читает `send_to`:

- **Tron** — EVM-адрес в младших 20 байтах, старшие 12 нулевые (как EVM);
- **Aptos / Sui** — полные 32 байта как native-адрес;
- **TON** — 32 байта account id, **workchain отброшен**.

Обе контрольные суммы проверены вычислением, а не по описанию:

- Tron round-trip `0xa614f803b6fd780986a42c78ec9c7f77e6ded13c` → `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
  (это USDT, и ровно этот адрес лежит в metadata как inner-token USDT0-адаптера);
- TON `EQDxL8F4t1RPjjBR45R3f6e60djNBUwWpI6wH3rV_8PJCLaw` → `0:f12fc178…c908`, workchain 0, bounceable.

Смена одного символа ловится в обоих форматах.

---

## Как ложится на текущую архитектуру

**Индикатор риска — менять не нужно.** `riskCovers()` в `src/core/guards.ts` требует `vm === 'evm'`
с обеих сторон, поэтому любой новый vm автоматически попадает в серый «индикатор не оценивает этот
маршрут». Guard 22 не трогается.

**Дискриминатор `vm`.** Сейчас `'evm' | 'svm'`. Tron стоит завести отдельным `'tvm'`, а не приписать
к EVM: ABI и формат адреса совместимы, но Multicall, explorer и кошелёк — нет. Если Tron унаследует
`isEvm`, он молча получит весь EVM-путь вместе с несуществующим Multicall.

**Белый список.** По той же схеме, что уже сделана для `lz-v1` и `lz-rescue`: новый модуль на сеть,
write-примитив только в нём, категория в `SCOPED_WRITES`. Оговорка: нынешняя проверка — grep по
TS-исходникам, и на Move-вызовах она не работает в принципе; для Aptos потребуется свой эквивалент.

**Спасение не покрывается** ни для одной из четырёх. `lz-rescue` читает `Packet` / `PacketSent` на
EVM-источнике: для EVM→сеть диагностика отправки частично живёт, dst-сторона — нет.

---

## Риски

**Асимметрия направлений, и она не техническая.** EVM→сеть остаётся на существующем EVM-пути: новое
там только кодирование получателя, чтение dst и трекинг. Обратное направление требует чужого кошелька,
чужого формата транзакции и ручной сборки вызова — а ручная сборка это ровно то, от чего защищает
белый список.

**«Четыре токена» на практике — один-два маршрута.** У TRUMP на Tron peers пусты на 30101/30110,
у Aptos-USDe единственный peer — 30101.

**CCIP на TON формально живой, но с пустым tokenAdminRegistry** — переводить нечего.

**Tron — единственная площадка, где прод-чтение упирается в 429** на публичном RPC.

---

## Предлагаемый порядок

1. **Tron, только как destination** (EVM→Tron). Получатель кодируется как EVM left-padded, валидация
   base58check — чистая функция, отправка идёт существующим путём. Живой кандидат: USDT0 (peers на
   Ethereum и Arbitrum); второй — WIF (BSC / Arbitrum / Base).
2. **Aptos, обе стороны.** Единственная сеть, где обратное направление реалистично без SDK: есть entry-
   функция и рабочий `quote_send`.
3. **TON, только EVM→TON.** Четыре адаптера реальные, но нужен CRC16 и решение, что делать с
   отброшенным workchain.
4. **Sui — не делать.**
