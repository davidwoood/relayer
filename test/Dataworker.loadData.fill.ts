import {
  BundleDataClient,
  ConfigStoreClient,
  GLOBAL_CONFIG_STORE_KEYS,
  HubPoolClient,
  SpokePoolClient,
} from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId, repaymentChainId } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  FakeContract,
  SignerWithAddress,
  V3FillFromDeposit,
  assertPromiseError,
  depositV3,
  ethers,
  expect,
  fillV3,
  getDefaultBlockRange,
  getDisabledBlockRanges,
  randomAddress,
  sinon,
  smock,
  spyLogIncludes,
} from "./utils";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { getCurrentTime, toBN, Event, toBNWei, fixedPointAdjustment, ZERO_ADDRESS, BigNumber } from "../src/utils";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { interfaces, utils as sdkUtils } from "@across-protocol/sdk";
import { cloneDeep } from "lodash";
import { CombinedRefunds } from "../src/dataworker/DataworkerUtils";
import { INFINITE_FILL_DEADLINE } from "../src/common";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient, bundleDataClient: BundleDataClient;
let hubPoolClient: HubPoolClient, configStoreClient: ConfigStoreClient;
let dataworkerInstance: Dataworker;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let spy: sinon.SinonSpy;

let updateAllClients: () => Promise<void>;

// TODO: Rename this file to BundleDataClient
describe("Dataworker: Load data used in all functions", async function () {
  beforeEach(async function () {
    ({
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      configStoreClient,
      hubPoolClient,
      l1Token_1,
      depositor,
      relayer,
      dataworkerInstance,
      spokePoolClient_1,
      spokePoolClient_2,
      spokePoolClients,
      updateAllClients,
      spy,
    } = await setupDataworker(ethers, 25, 25, 0));
    bundleDataClient = dataworkerInstance.clients.bundleDataClient;
  });

  it("Default conditions", async function () {
    await configStoreClient.update();

    // Throws error if hub pool client is not updated.
    await hubPoolClient.update();

    // Throws error if spoke pool clients not updated
    await assertPromiseError(bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients), "SpokePoolClient");
    await spokePoolClient_1.update();
    await spokePoolClient_2.update();

    // Before any deposits, returns empty dictionaries.
    await updateAllClients();
    expect(await bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients)).to.deep.equal({
      bundleDepositsV3: {},
      expiredDepositsToRefundV3: {},
      bundleFillsV3: {},
      unexecutableSlowFills: {},
      bundleSlowFillsV3: {},
    });
  });

  describe("V3 Events", function () {
    let mockOriginSpokePoolClient: MockSpokePoolClient, mockDestinationSpokePoolClient: MockSpokePoolClient;
    let mockHubPoolClient: MockHubPoolClient;
    let mockDestinationSpokePool: FakeContract;
    let mockConfigStore: MockConfigStoreClient;
    const lpFeePct = toBNWei("0.01");

    beforeEach(async function () {
      await updateAllClients();
      mockHubPoolClient = new MockHubPoolClient(
        hubPoolClient.logger,
        hubPoolClient.hubPool,
        configStoreClient,
        hubPoolClient.deploymentBlock,
        hubPoolClient.chainId
      );
      mockConfigStore = new MockConfigStoreClient(
        configStoreClient.logger,
        configStoreClient.configStore,
        undefined,
        undefined,
        undefined,
        undefined,
        true
      );
      // Mock a realized lp fee pct for each deposit so we can check refund amounts and bundle lp fees.
      mockHubPoolClient.setDefaultRealizedLpFeePct(lpFeePct);
      mockOriginSpokePoolClient = new MockSpokePoolClient(
        spokePoolClient_1.logger,
        spokePoolClient_1.spokePool,
        spokePoolClient_1.chainId,
        spokePoolClient_1.deploymentBlock
      );
      mockDestinationSpokePool = await smock.fake(spokePoolClient_2.spokePool.interface);
      mockDestinationSpokePoolClient = new MockSpokePoolClient(
        spokePoolClient_2.logger,
        mockDestinationSpokePool as Contract,
        spokePoolClient_2.chainId,
        spokePoolClient_2.deploymentBlock
      );
      spokePoolClients = {
        ...spokePoolClients,
        [originChainId]: mockOriginSpokePoolClient,
        [destinationChainId]: mockDestinationSpokePoolClient,
      };
      await mockHubPoolClient.update();
      await mockOriginSpokePoolClient.update();
      await mockDestinationSpokePoolClient.update();
      mockHubPoolClient.setTokenMapping(l1Token_1.address, originChainId, erc20_1.address);
      mockHubPoolClient.setTokenMapping(l1Token_1.address, destinationChainId, erc20_2.address);
      mockHubPoolClient.setTokenMapping(l1Token_1.address, repaymentChainId, l1Token_1.address);
      const bundleDataClient = new BundleDataClient(
        dataworkerInstance.logger,
        {
          ...dataworkerInstance.clients.bundleDataClient.clients,
          hubPoolClient: mockHubPoolClient as unknown as HubPoolClient,
        },
        dataworkerInstance.clients.bundleDataClient.spokePoolClients,
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers
      );
      dataworkerInstance = new Dataworker(
        dataworkerInstance.logger,
        { ...dataworkerInstance.clients, bundleDataClient },
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers,
        dataworkerInstance.maxRefundCountOverride,
        dataworkerInstance.maxL1TokenCountOverride,
        dataworkerInstance.blockRangeEndBlockBuffer
      );
    });

    function generateV3Deposit(eventOverride?: Partial<interfaces.DepositWithBlock>): Event {
      return mockOriginSpokePoolClient.depositV3({
        inputToken: erc20_1.address,
        outputToken: eventOverride?.outputToken ?? erc20_2.address,
        message: "0x",
        quoteTimestamp: eventOverride?.quoteTimestamp ?? getCurrentTime() - 10,
        fillDeadline: eventOverride?.fillDeadline ?? getCurrentTime() + 14400,
        destinationChainId,
        blockNumber: eventOverride?.blockNumber ?? spokePoolClient_1.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.DepositWithBlock);
    }

    function generateV3FillFromDeposit(
      deposit: interfaces.DepositWithBlock,
      fillEventOverride?: Partial<interfaces.FillWithBlock>,
      _relayer = relayer.address,
      _repaymentChainId = repaymentChainId,
      fillType = interfaces.FillType.FastFill
    ): Event {
      const fillObject = V3FillFromDeposit(deposit, _relayer, _repaymentChainId);
      return mockDestinationSpokePoolClient.fillV3Relay({
        ...fillObject,
        relayExecutionInfo: {
          updatedRecipient: fillObject.updatedRecipient,
          updatedMessage: fillObject.updatedMessage,
          updatedOutputAmount: fillObject.updatedOutputAmount,
          fillType,
        },
        blockNumber: fillEventOverride?.blockNumber ?? spokePoolClient_2.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.FillWithBlock);
    }

    function generateV3FillFromDepositEvent(
      depositEvent: Event,
      fillEventOverride?: Partial<interfaces.FillWithBlock>,
      _relayer = relayer.address,
      _repaymentChainId = repaymentChainId,
      fillType = interfaces.FillType.FastFill,
      outputAmount: BigNumber = depositEvent.args.outputAmount,
      updatedOutputAmount: BigNumber = depositEvent.args.outputAmount
    ): Event {
      const { args } = depositEvent;
      return mockDestinationSpokePoolClient.fillV3Relay({
        ...args,
        relayer: _relayer,
        outputAmount,
        repaymentChainId: _repaymentChainId,
        relayExecutionInfo: {
          updatedRecipient: depositEvent.updatedRecipient,
          updatedMessage: depositEvent.updatedMessage,
          updatedOutputAmount: updatedOutputAmount,
          fillType,
        },
        blockNumber: fillEventOverride?.blockNumber ?? spokePoolClient_2.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.FillWithBlock);
    }

    it("Filters expired deposits", async function () {
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send unexpired deposit
      const unexpiredDeposits = [generateV3Deposit()];
      // Send expired deposit
      const expiredDeposits = [generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 })];
      const depositEvents = [...unexpiredDeposits, ...expiredDeposits];
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].map((deposit) => deposit.depositId)).to.deep.equal(
        depositEvents.map((event) => event.args.depositId)
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(2);
      expect(
        data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].map((deposit) => deposit.depositId)
      ).to.deep.equal(expiredDeposits.map((event) => event.args.depositId));
      expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
    });

    it("Ignores disabled chains", async function () {
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send unexpired deposit
      generateV3Deposit();
      // Send expired deposit
      generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

      // Returns no data if block range is undefined
      const emptyData = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDisabledBlockRanges(),
        spokePoolClients
      );
      expect(emptyData.bundleDepositsV3).to.deep.equal({});
      expect(emptyData.expiredDepositsToRefundV3).to.deep.equal({});
    });

    it("Filters unexpired deposit out of block range", async function () {
      // Send deposit behind and after origin chain block range. Should not be included in bundleDeposits.
      // First generate mock deposit events with some block time between events.
      const deposits = [
        generateV3Deposit({ blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 1 }),
        generateV3Deposit({ blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 11 }),
        generateV3Deposit({ blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 21 }),
      ];
      // Create a block range that contains only the middle deposit.
      const originChainBlockRange = [deposits[1].blockNumber - 1, deposits[1].blockNumber + 1];
      // Substitute origin chain bundle block range.
      const bundleBlockRanges = [originChainBlockRange].concat(getDefaultBlockRange(5).slice(1));
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      expect(mockOriginSpokePoolClient.getDeposits().length).to.equal(deposits.length);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address][0].depositId).to.equal(deposits[1].args.depositId);
    });
    it("Ignores expired deposits that were filled in same bundle", async function () {
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send deposit that expires in this bundle.
      const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
      expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);

      // Now, send a fill for the deposit that would be in the same bundle. This should eliminate the expired
      // deposit from a refund.
      generateV3FillFromDepositEvent(expiredDeposit);
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const data2 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(6),
        spokePoolClients
      );
      expect(data2.expiredDepositsToRefundV3).to.deep.equal({});
      expect(data2.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    });
    it("Saves V3 fast fill under correct repayment chain and repayment token", async function () {
      const depositV3Events: Event[] = [];
      const fillV3Events: Event[] = [];

      // Create three valid deposits
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      // Fill deposits from different relayers
      const relayer2 = randomAddress();
      fillV3Events.push(generateV3FillFromDeposit(deposits[0]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[1]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[2], {}, relayer2));
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(depositV3Events.length);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.map((e) => e.depositId)).to.deep.equal(
        fillV3Events.map((event) => event.args.depositId)
      );
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.map((e) => e.lpFeePct)).to.deep.equal(
        fillV3Events.map(() => lpFeePct)
      );
      const totalGrossRefundAmount = fillV3Events.reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0));
      const totalV3LpFees = totalGrossRefundAmount.mul(lpFeePct).div(fixedPointAdjustment);
      expect(totalV3LpFees).to.equal(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].realizedLpFees);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].totalRefundAmount).to.equal(
        totalGrossRefundAmount.sub(totalV3LpFees)
      );
      const refundAmountPct = fixedPointAdjustment.sub(lpFeePct);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].refunds).to.deep.equal({
        [relayer.address]: fillV3Events
          .slice(0, fillV3Events.length - 1)
          .reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0))
          .mul(refundAmountPct)
          .div(fixedPointAdjustment),
        [relayer2]: fillV3Events[fillV3Events.length - 1].args.inputAmount
          .mul(refundAmountPct)
          .div(fixedPointAdjustment),
      });
    });
    it("Ignores disabled chains", async function () {
      const depositV3Events: Event[] = [];
      const fillV3Events: Event[] = [];

      // Create three valid deposits
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      // Fill deposits from different relayers
      const relayer2 = randomAddress();
      fillV3Events.push(generateV3FillFromDeposit(deposits[0]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[1]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[2], {}, relayer2));
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const emptyData = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDisabledBlockRanges(),
        spokePoolClients
      );
      expect(emptyData.bundleFillsV3).to.deep.equal({});
    });
    it("Saves V3 fast fill under correct repayment chain and repayment token when dealing with lite chains", async function () {
      // Mock the config store client to include the lite chain index.
      mockConfigStore.updateGlobalConfig(
        GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
        JSON.stringify([originChainId])
      );
      await mockConfigStore.update();
      // Ensure that our test has the right setup.
      expect(mockConfigStore.liteChainIndicesUpdates.length).to.equal(1);
      mockConfigStore.liteChainIndicesUpdates[0].timestamp = 0;
      expect(repaymentChainId).to.not.eq(originChainId);

      // Mock the config store client being included on the spoke client
      mockOriginSpokePoolClient.setConfigStoreClient(mockConfigStore);

      const depositV3Events: Event[] = [];
      const fillV3Events: Event[] = [];

      // Create three valid deposits
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      // Fill deposits from different relayers
      const relayer2 = randomAddress();
      fillV3Events.push(generateV3FillFromDeposit(deposits[0]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[1]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[2], {}, relayer2));
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.length).to.equal(depositV3Events.length);
      expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.map((e) => e.depositId)).to.deep.equal(
        fillV3Events.map((event) => event.args.depositId)
      );
      expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.map((e) => e.lpFeePct)).to.deep.equal(
        fillV3Events.map(() => lpFeePct)
      );
      const totalGrossRefundAmount = fillV3Events.reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0));
      const totalV3LpFees = totalGrossRefundAmount.mul(lpFeePct).div(fixedPointAdjustment);
      expect(totalV3LpFees).to.equal(data1.bundleFillsV3[originChainId][erc20_1.address].realizedLpFees);
      expect(data1.bundleFillsV3[originChainId][erc20_1.address].totalRefundAmount).to.equal(
        totalGrossRefundAmount.sub(totalV3LpFees)
      );
      const refundAmountPct = fixedPointAdjustment.sub(lpFeePct);
      expect(data1.bundleFillsV3[originChainId][erc20_1.address].refunds).to.deep.equal({
        [relayer.address]: fillV3Events
          .slice(0, fillV3Events.length - 1)
          .reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0))
          .mul(refundAmountPct)
          .div(fixedPointAdjustment),
        [relayer2]: fillV3Events[fillV3Events.length - 1].args.inputAmount
          .mul(refundAmountPct)
          .div(fixedPointAdjustment),
      });
    });

    it("Validates fill against old deposit", async function () {
      // For this test, we need to actually send a deposit on the spoke pool
      // because queryHistoricalDepositForFill eth_call's the contract.

      // Send a legacy deposit.
      const depositObject = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_2.address,
        amountToDeposit,
        {
          fillDeadline: INFINITE_FILL_DEADLINE.toNumber(),
        }
      );
      const depositBlock = await spokePool_1.provider.getBlockNumber();

      // Construct a spoke pool client with a small search range that would not include the deposit.
      spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
      spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
      await spokePoolClient_1.update();
      const deposits = spokePoolClient_1.getDeposits();
      expect(deposits.length).to.equal(0);

      // Send a fill now and force the bundle data client to query for the historical deposit.
      await fillV3(spokePool_2, relayer, depositObject);
      await updateAllClients();
      const fills = spokePoolClient_2.getFills();
      expect(fills.length).to.equal(1);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
        ...spokePoolClients,
        [originChainId]: spokePoolClient_1,
        [destinationChainId]: spokePoolClient_2,
      });
      expect(spyLogIncludes(spy, -4, "Located V3 deposit outside of SpokePoolClient's search range")).is.true;
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
      expect(data1.bundleDepositsV3).to.deep.equal({});
    });
    it("Validates fill from lite chain against old deposit", async function () {
      // For this test, we need to actually send a deposit on the spoke pool
      // because queryHistoricalDepositForFill eth_call's the contract.

      // Send a legacy deposit where the fill deadline is infinite, so we can test the bundle data client uses
      // queryHistoricalDepositForFill to find the deposit.
      const depositObject = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_2.address,
        amountToDeposit,
        {
          fillDeadline: INFINITE_FILL_DEADLINE.toNumber(),
        }
      );
      const depositBlock = await spokePool_1.provider.getBlockNumber();
      // Construct a spoke pool client with a small search range that would not include the deposit.
      spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
      spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
      await spokePoolClient_1.update();
      const deposits = spokePoolClient_1.getDeposits();
      expect(deposits.length).to.equal(0);

      // Mock the config store client to include the lite chain index.
      mockConfigStore.updateGlobalConfig(
        GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
        JSON.stringify([originChainId])
      );
      await mockConfigStore.update();
      // Ensure that our test has the right setup.
      expect(mockConfigStore.liteChainIndicesUpdates.length).to.equal(1);
      mockConfigStore.liteChainIndicesUpdates[0].timestamp = depositObject.quoteTimestamp - 1;
      expect(mockConfigStore.liteChainIndicesUpdates[0].timestamp).to.be.lt(depositObject.quoteTimestamp);
      expect(repaymentChainId).to.not.eq(originChainId);

      // Mock the config store client being included on the spoke client
      (spokePoolClient_1 as any).configStoreClient = mockConfigStore;

      // Send a fill now and force the bundle data client to query for the historical deposit.
      await fillV3(spokePool_2, relayer, depositObject);
      await updateAllClients();
      const fills = spokePoolClient_2.getFills();
      expect(fills.length).to.equal(1);

      // Load information needed to build a bundle
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
        ...spokePoolClients,
        [originChainId]: spokePoolClient_1,
        [destinationChainId]: spokePoolClient_2,
      });
      expect(spyLogIncludes(spy, -4, "Located V3 deposit outside of SpokePoolClient's search range")).is.true;

      // Ensure the repayment chain id is not in the bundle data.
      expect(data1.bundleFillsV3[repaymentChainId]).to.be.undefined;
      // Make sure that the origin data is in fact populated
      expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.length).to.eq(1);
      expect(data1.bundleDepositsV3).to.deep.equal({});
    });
    it("Searches for old deposit for fill but cannot find matching one", async function () {
      // For this test, we need to actually send a deposit on the spoke pool
      // because queryHistoricalDepositForFill eth_call's the contract.

      // Send a legacy deposit.
      const depositObject = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_2.address,
        amountToDeposit,
        {
          fillDeadline: INFINITE_FILL_DEADLINE.toNumber(),
        }
      );
      const depositBlock = await spokePool_1.provider.getBlockNumber();

      // Construct a spoke pool client with a small search range that would not include the deposit.
      spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
      spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
      await spokePoolClient_1.update();
      const deposits = spokePoolClient_1.getDeposits();
      expect(deposits.length).to.equal(0);

      // Send a fill now and force the bundle data client to query for the historical deposit.
      // However, send a fill that doesn't match with the above deposit. This should produce an invalid fill.
      await fillV3(spokePool_2, relayer, { ...depositObject, depositId: depositObject.depositId + 1 });
      await updateAllClients();
      const fills = spokePoolClient_2.getFills();
      expect(fills.length).to.equal(1);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
        ...spokePoolClients,
        [originChainId]: spokePoolClient_1,
        [destinationChainId]: spokePoolClient_2,
      });
      expect(data1.bundleFillsV3).to.deep.equal({});
      expect(data1.bundleDepositsV3).to.deep.equal({});
    });
    it("Filters fills out of block range", async function () {
      generateV3Deposit({ outputToken: randomAddress() });
      generateV3Deposit({ outputToken: randomAddress() });
      generateV3Deposit({ outputToken: randomAddress() });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      const fills = [
        generateV3FillFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 1,
        }),
        generateV3FillFromDeposit(deposits[1], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 11,
        }),
        generateV3FillFromDeposit(deposits[2], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 21,
        }),
      ];
      // Create a block range that contains only the middle event.
      const destinationChainBlockRange = [fills[1].blockNumber - 1, fills[1].blockNumber + 1];
      // Substitute destination chain bundle block range.
      const bundleBlockRanges = getDefaultBlockRange(5);
      const destinationChainIndex =
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
      bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      expect(mockDestinationSpokePoolClient.getFills().length).to.equal(fills.length);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills[0].depositId).to.equal(
        fills[1].args.depositId
      );
    });
    it("Handles invalid fills", async function () {
      const depositEvent = generateV3Deposit();
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const invalidRelayData = {
        depositor: randomAddress(),
        recipient: randomAddress(),
        exclusiveRelayer: randomAddress(),
        inputToken: erc20_2.address,
        outputToken: erc20_1.address,
        inputAmount: depositEvent.args.inputAmount.add(1),
        outputAmount: depositEvent.args.outputAmount.add(1),
        originChainId: destinationChainId,
        depositId: depositEvent.args.depositId + 1,
        fillDeadline: depositEvent.args.fillDeadline + 1,
        exclusivityDeadline: depositEvent.args.exclusivityDeadline + 1,
        message: randomAddress(),
        destinationChainId: originChainId,
      };
      for (const [key, val] of Object.entries(invalidRelayData)) {
        const _depositEvent = cloneDeep(depositEvent);
        _depositEvent.args[key] = val;
        if (key === "inputToken") {
          // @dev if input token is changed, make origin chain match the chain where the replacement
          // token address is located so that bundle data client can determine its "repayment" token.
          _depositEvent.args.originChainId = destinationChainId;
        }
        generateV3FillFromDepositEvent(_depositEvent);
      }
      // Send one valid fill as a base test case.
      generateV3FillFromDepositEvent(depositEvent);
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
      expect(spyLogIncludes(spy, -2, "invalid V3 fills in range")).to.be.true;
    });
    it("Matches fill with deposit with outputToken = 0x0", async function () {
      await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        ZERO_ADDRESS,
        amountToDeposit
      );
      await spokePoolClient_1.update();
      const deposit = spokePoolClient_1.getDeposits()[0];
      await fillV3(spokePool_2, relayer, deposit);
      await spokePoolClient_2.update();
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
        ...spokePoolClients,
        [originChainId]: spokePoolClient_1,
        [destinationChainId]: spokePoolClient_2,
      });
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    });

    it("Returns prior bundle expired deposits", async function () {
      // Send deposit that expires in this bundle.
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send deposit that expires in this bundle.
      const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
      expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);

      // Now, load a bundle that doesn't include the deposit in its range.
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
      const bundleBlockRanges = getDefaultBlockRange(5);
      bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
      const data2 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

      // Now, there is no bundle deposit but still an expired deposit to refund.
      expect(data2.bundleDepositsV3).to.deep.equal({});
      expect(data2.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
    });
    it("Handles when deposit is greater than origin bundle end block but fill is within range", async function () {
      // Send deposit after origin chain block range.
      const blockRanges = getDefaultBlockRange(5);
      const futureDeposit = generateV3Deposit();
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      blockRanges[originChainIndex] = [blockRanges[0][0], futureDeposit.blockNumber - 1];

      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

      generateV3FillFromDepositEvent(futureDeposit);
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(blockRanges, spokePoolClients);
      expect(data1.bundleDepositsV3).to.deep.equal({});
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
      expect(spyLogIncludes(spy, -2, "invalid V3 fills in range")).to.be.false;
    });
    it("Does not count prior bundle expired deposits that were filled", async function () {
      // Send deposit that expires in this bundle.
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

      // Let's make fill status for the relay hash always return Filled.
      const expiredDepositHash = sdkUtils.getRelayHashFromEvent(mockOriginSpokePoolClient.getDeposits()[0]);
      mockDestinationSpokePool.fillStatuses.whenCalledWith(expiredDepositHash).returns(interfaces.FillStatus.Filled);

      // Now, load a bundle that doesn't include the deposit in its range.
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
      const bundleBlockRanges = getDefaultBlockRange(5);
      bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

      // There should be no expired deposit to refund because its fill status is Filled.
      expect(data1.bundleDepositsV3).to.deep.equal({});
      expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
    });
    it("Does not count prior bundle expired deposits that we queried a fill for", async function () {
      // Send deposit that expires in this bundle.
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      // Unlike previous test, we send a fill that the spoke pool client should query which also eliminates this
      // expired deposit from being refunded.
      generateV3FillFromDeposit(deposits[0]);
      await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill", "FilledV3Relay"]);
      expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);

      // Now, load a bundle that doesn't include the deposit in its range.
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
      const bundleBlockRanges = getDefaultBlockRange(5);
      bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

      // There should be no expired deposit to refund.
      expect(data1.bundleDepositsV3).to.deep.equal({});
      expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    });

    it("getBundleTimestampsFromCache and setBundleTimestampsInCache", async function () {
      // Unit test
      await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);
      await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(6), spokePoolClients);

      const key1 = JSON.stringify(getDefaultBlockRange(5));
      const key2 = JSON.stringify(getDefaultBlockRange(6));
      const cache1 = dataworkerInstance.clients.bundleDataClient.getBundleTimestampsFromCache(key1);
      const cache2 = dataworkerInstance.clients.bundleDataClient.getBundleTimestampsFromCache(key2);
      expect(cache1).to.not.be.undefined;
      expect(cache2).to.not.be.undefined;

      const key3 = "random";
      expect(dataworkerInstance.clients.bundleDataClient.getBundleTimestampsFromCache(key3)).to.be.undefined;
      const cache3 = { ...cache1, [destinationChainId]: [0, 0] };
      dataworkerInstance.clients.bundleDataClient.setBundleTimestampsInCache(key3, cache3);
      expect(dataworkerInstance.clients.bundleDataClient.getBundleTimestampsFromCache(key3)).to.deep.equal(cache3);
    });
  });

  describe("Miscellaneous functions", function () {
    it("getUpcomingDepositAmount", async function () {
      // Send two deposits on different chains
      await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        ZERO_ADDRESS,
        amountToDeposit
      );
      await depositV3(
        spokePool_2,
        originChainId,
        depositor,
        erc20_2.address,
        amountToDeposit,
        ZERO_ADDRESS,
        amountToDeposit
      );
      await updateAllClients();
      expect(await bundleDataClient.getUpcomingDepositAmount(originChainId, erc20_1.address, 0)).to.equal(
        amountToDeposit
      );
      expect(await bundleDataClient.getUpcomingDepositAmount(destinationChainId, erc20_2.address, 0)).to.equal(
        amountToDeposit
      );

      // Removes deposits using block, token, and chain filters.
      expect(
        await bundleDataClient.getUpcomingDepositAmount(
          originChainId,
          erc20_1.address,
          spokePoolClient_1.latestBlockSearched // block higher than the deposit
        )
      ).to.equal(0);
      expect(
        await bundleDataClient.getUpcomingDepositAmount(
          originChainId,
          erc20_2.address, // diff token
          0
        )
      ).to.equal(0);
      expect(
        await bundleDataClient.getUpcomingDepositAmount(
          destinationChainId, // diff chain
          erc20_1.address,
          0
        )
      ).to.equal(0);

      // spoke pool client for chain not defined
      expect(
        await bundleDataClient.getUpcomingDepositAmount(
          originChainId + destinationChainId + repaymentChainId + 1, // spoke pool client for chain is not defined in BundleDataClient
          erc20_1.address,
          0
        )
      ).to.equal(0);
    });
    it("getApproximateRefundsForBlockRange", async function () {
      // Send two deposits on different chains
      // Fill both deposits and request repayment on same chain
      await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        ZERO_ADDRESS,
        amountToDeposit
      );
      await depositV3(
        spokePool_2,
        originChainId,
        depositor,
        erc20_2.address,
        amountToDeposit,
        ZERO_ADDRESS,
        amountToDeposit
      );
      await updateAllClients();
      const deposit1 = spokePoolClient_1.getDeposits()[0];
      const deposit2 = spokePoolClient_2.getDeposits()[0];

      await fillV3(spokePool_2, relayer, deposit1, originChainId);
      await fillV3(spokePool_1, relayer, deposit2, originChainId);

      // Approximate refunds should count both fills
      await updateAllClients();
      const refunds = bundleDataClient.getApproximateRefundsForBlockRange(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5)
      );
      const expectedRefunds = {
        [originChainId]: {
          [erc20_1.address]: {
            [relayer.address]: BigNumber.from(amountToDeposit.mul(2)).toString(),
          },
        },
      };

      // Convert refunds to have a nested string instead of BigNumber. It's three levels deep
      // which is a bit ugly but it's the easiest way to compare the two objects that are having
      // these BN issues.
      const convertToNumericStrings = (data: CombinedRefunds) =>
        Object.entries(data).reduce(
          (acc, [chainId, refunds]) => ({
            ...acc,
            [chainId]: Object.entries(refunds).reduce(
              (acc, [token, refunds]) => ({
                ...acc,
                [token]: Object.entries(refunds).reduce(
                  (acc, [address, amount]) => ({ ...acc, [address]: amount.toString() }),
                  {}
                ),
              }),
              {}
            ),
          }),
          {}
        );

      expect(convertToNumericStrings(refunds)).to.deep.equal(expectedRefunds);

      // Send an invalid fill and check it is not included.
      await fillV3(spokePool_1, relayer, { ...deposit1, depositId: deposit1.depositId + 1 }, originChainId);
      await updateAllClients();
      expect(
        convertToNumericStrings(
          bundleDataClient.getApproximateRefundsForBlockRange(
            [originChainId, destinationChainId],
            getDefaultBlockRange(5)
          )
        )
      ).to.deep.equal({
        [originChainId]: {
          [erc20_1.address]: {
            [relayer.address]: amountToDeposit.mul(2).toString(),
          },
        },
      });
    });
  });
});
