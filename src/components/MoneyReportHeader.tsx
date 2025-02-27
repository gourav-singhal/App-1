import {useRoute} from '@react-navigation/native';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View} from 'react-native';
import type {OnyxEntry} from 'react-native-onyx';
import {useOnyx} from 'react-native-onyx';
import useLocalize from '@hooks/useLocalize';
import useNetwork from '@hooks/useNetwork';
import useResponsiveLayout from '@hooks/useResponsiveLayout';
import useTheme from '@hooks/useTheme';
import useThemeStyles from '@hooks/useThemeStyles';
import {getCurrentUserAccountID} from '@libs/actions/Report';
import {convertToDisplayString} from '@libs/CurrencyUtils';
import Navigation from '@libs/Navigation/Navigation';
import {getConnectedIntegration, isPolicyAdmin} from '@libs/PolicyUtils';
import {getOriginalMessage, isDeletedAction, isMoneyRequestAction, isTrackExpenseAction} from '@libs/ReportActionsUtils';
import {
    canBeExported,
    canDeleteTransaction,
    getArchiveReason,
    getBankAccountRoute,
    getMoneyRequestSpendBreakdown,
    getNonHeldAndFullAmount,
    getTransactionsWithReceipts,
    hasHeldExpenses as hasHeldExpensesReportUtils,
    hasOnlyHeldExpenses as hasOnlyHeldExpensesReportUtils,
    hasUpdatedTotal,
    isAllowedToApproveExpenseReport,
    isAllowedToSubmitDraftExpenseReport,
    isArchivedReport as isArchivedReportUtils,
    isClosedExpenseReportWithNoExpenses,
    isCurrentUserSubmitter,
    isInvoiceReport,
    isOpenExpenseReport,
    navigateBackOnDeleteTransaction,
} from '@libs/ReportUtils';
import {
    allHavePendingRTERViolation,
    getAllReportTransactions,
    isDuplicate as isDuplicateTransactionUtils,
    isExpensifyCardTransaction,
    isOnHold as isOnHoldTransactionUtils,
    isPayAtEndExpense as isPayAtEndExpenseTransactionUtils,
    isPending,
    isReceiptBeingScanned,
    shouldShowBrokenConnectionViolation as shouldShowBrokenConnectionViolationTransactionUtils,
} from '@libs/TransactionUtils';
import variables from '@styles/variables';
import {approveMoneyRequest, canApproveIOU, canIOUBePaid as canIOUBePaidAction, deleteMoneyRequest, deleteTrackExpense, payInvoice, payMoneyRequest, submitReport} from '@userActions/IOU';
import {markAsCash as markAsCashAction} from '@userActions/Transaction';
import CONST from '@src/CONST';
import useDelegateUserDetails from '@src/hooks/useDelegateUserDetails';
import ONYXKEYS from '@src/ONYXKEYS';
import type {Route} from '@src/ROUTES';
import ROUTES from '@src/ROUTES';
import SCREENS from '@src/SCREENS';
import type * as OnyxTypes from '@src/types/onyx';
import type {PaymentMethodType} from '@src/types/onyx/OriginalMessage';
import type IconAsset from '@src/types/utils/IconAsset';
import isLoadingOnyxValue from '@src/types/utils/isLoadingOnyxValue';
import BrokenConnectionDescription from './BrokenConnectionDescription';
import Button from './Button';
import ConfirmModal from './ConfirmModal';
import DelegateNoAccessModal from './DelegateNoAccessModal';
import HeaderWithBackButton from './HeaderWithBackButton';
import Icon from './Icon';
import * as Expensicons from './Icon/Expensicons';
import MoneyReportHeaderStatusBar from './MoneyReportHeaderStatusBar';
import type {MoneyRequestHeaderStatusBarProps} from './MoneyRequestHeaderStatusBar';
import MoneyRequestHeaderStatusBar from './MoneyRequestHeaderStatusBar';
import type {ActionHandledType} from './ProcessMoneyReportHoldMenu';
import ProcessMoneyReportHoldMenu from './ProcessMoneyReportHoldMenu';
import ExportWithDropdownMenu from './ReportActionItem/ExportWithDropdownMenu';
import SettlementButton from './SettlementButton';

type MoneyReportHeaderProps = {
    /** The report currently being looked at */
    report: OnyxEntry<OnyxTypes.Report>;

    /** The policy tied to the expense report */
    policy: OnyxEntry<OnyxTypes.Policy>;

    /** Array of report actions for the report */
    reportActions: OnyxTypes.ReportAction[];

    /** The reportID of the transaction thread report associated with this current report, if any */
    // eslint-disable-next-line react/no-unused-prop-types
    transactionThreadReportID: string | undefined;

    /** Method to trigger when pressing close button of the header */
    onBackButtonPress: () => void;
};

function MoneyReportHeader({policy, report: moneyRequestReport, transactionThreadReportID, reportActions, onBackButtonPress}: MoneyReportHeaderProps) {
    // We need to use isSmallScreenWidth instead of shouldUseNarrowLayout to use a correct layout for the hold expense modal https://github.com/Expensify/App/pull/47990#issuecomment-2362382026
    // eslint-disable-next-line rulesdir/prefer-shouldUseNarrowLayout-instead-of-isSmallScreenWidth
    const {shouldUseNarrowLayout, isSmallScreenWidth} = useResponsiveLayout();
    const route = useRoute();
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const [chatReport] = useOnyx(`${ONYXKEYS.COLLECTION.REPORT}${moneyRequestReport?.chatReportID || CONST.DEFAULT_NUMBER_ID}`);
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const [nextStep] = useOnyx(`${ONYXKEYS.COLLECTION.NEXT_STEP}${moneyRequestReport?.reportID || CONST.DEFAULT_NUMBER_ID}`);
    const [transactionThreadReport] = useOnyx(`${ONYXKEYS.COLLECTION.REPORT}${transactionThreadReportID}`);
    const [session] = useOnyx(ONYXKEYS.SESSION);
    const requestParentReportAction = useMemo(() => {
        if (!reportActions || !transactionThreadReport?.parentReportActionID) {
            return null;
        }
        return reportActions.find((action): action is OnyxTypes.ReportAction<typeof CONST.REPORT.ACTIONS.TYPE.IOU> => action.reportActionID === transactionThreadReport.parentReportActionID);
    }, [reportActions, transactionThreadReport?.parentReportActionID]);
    const [transactions] = useOnyx(ONYXKEYS.COLLECTION.TRANSACTION);
    const [dismissedHoldUseExplanation, dismissedHoldUseExplanationResult] = useOnyx(ONYXKEYS.NVP_DISMISSED_HOLD_USE_EXPLANATION, {initialValue: true});
    const isLoadingHoldUseExplained = isLoadingOnyxValue(dismissedHoldUseExplanationResult);
    const transaction =
        transactions?.[`${ONYXKEYS.COLLECTION.TRANSACTION}${isMoneyRequestAction(requestParentReportAction) && getOriginalMessage(requestParentReportAction)?.IOUTransactionID}`] ??
        undefined;

    const styles = useThemeStyles();
    const theme = useTheme();
    const [isDeleteRequestModalVisible, setIsDeleteRequestModalVisible] = useState(false);
    const {translate} = useLocalize();
    const {isOffline} = useNetwork();
    const {reimbursableSpend} = getMoneyRequestSpendBreakdown(moneyRequestReport);
    const isOnHold = isOnHoldTransactionUtils(transaction);
    const isDeletedParentAction = !!requestParentReportAction && isDeletedAction(requestParentReportAction);
    const isDuplicate = isDuplicateTransactionUtils(transaction?.transactionID);

    // Only the requestor can delete the request, admins can only edit it.
    const isActionOwner =
        typeof requestParentReportAction?.actorAccountID === 'number' && typeof session?.accountID === 'number' && requestParentReportAction.actorAccountID === session?.accountID;
    const canDeleteRequest = isActionOwner && canDeleteTransaction(moneyRequestReport) && !isDeletedParentAction;
    const [isHoldMenuVisible, setIsHoldMenuVisible] = useState(false);
    const [paymentType, setPaymentType] = useState<PaymentMethodType>();
    const [requestType, setRequestType] = useState<ActionHandledType>();
    const allTransactions = useMemo(() => getAllReportTransactions(moneyRequestReport?.reportID, transactions), [moneyRequestReport?.reportID, transactions]);
    const canAllowSettlement = hasUpdatedTotal(moneyRequestReport, policy);
    const policyType = policy?.type;
    const isDraft = isOpenExpenseReport(moneyRequestReport);
    const connectedIntegration = getConnectedIntegration(policy);
    const navigateBackToAfterDelete = useRef<Route>();
    const hasHeldExpenses = hasHeldExpensesReportUtils(moneyRequestReport?.reportID);
    const hasScanningReceipt = getTransactionsWithReceipts(moneyRequestReport?.reportID).some((t) => isReceiptBeingScanned(t));
    const hasOnlyPendingTransactions = allTransactions.length > 0 && allTransactions.every((t) => isExpensifyCardTransaction(t) && isPending(t));
    const transactionIDs = allTransactions.map((t) => t.transactionID);
    const hasAllPendingRTERViolations = allHavePendingRTERViolation([transaction?.transactionID]);
    const shouldShowBrokenConnectionViolation = shouldShowBrokenConnectionViolationTransactionUtils(transaction?.transactionID, moneyRequestReport, policy);
    const hasOnlyHeldExpenses = hasOnlyHeldExpensesReportUtils(moneyRequestReport?.reportID);
    const isPayAtEndExpense = isPayAtEndExpenseTransactionUtils(transaction);
    const isArchivedReport = isArchivedReportUtils(moneyRequestReport);
    const [archiveReason] = useOnyx(`${ONYXKEYS.COLLECTION.REPORT_ACTIONS}${moneyRequestReport?.reportID}`, {selector: getArchiveReason});

    const getCanIOUBePaid = useCallback(
        (onlyShowPayElsewhere = false) => canIOUBePaidAction(moneyRequestReport, chatReport, policy, transaction ? [transaction] : undefined, onlyShowPayElsewhere),
        [moneyRequestReport, chatReport, policy, transaction],
    );
    const canIOUBePaid = useMemo(() => getCanIOUBePaid(), [getCanIOUBePaid]);

    const onlyShowPayElsewhere = useMemo(() => !canIOUBePaid && getCanIOUBePaid(true), [canIOUBePaid, getCanIOUBePaid]);

    const shouldShowMarkAsCashButton =
        hasAllPendingRTERViolations || (shouldShowBrokenConnectionViolation && (!isPolicyAdmin(policy) || isCurrentUserSubmitter(moneyRequestReport?.reportID)));

    const shouldShowPayButton = canIOUBePaid || onlyShowPayElsewhere;

    const shouldShowApproveButton = useMemo(() => canApproveIOU(moneyRequestReport, policy) && !hasOnlyPendingTransactions, [moneyRequestReport, policy, hasOnlyPendingTransactions]);

    const shouldDisableApproveButton = shouldShowApproveButton && !isAllowedToApproveExpenseReport(moneyRequestReport);

    const currentUserAccountID = getCurrentUserAccountID();
    const isAdmin = policy?.role === CONST.POLICY.ROLE.ADMIN;

    const shouldShowSubmitButton =
        !!moneyRequestReport &&
        !isArchivedReport &&
        isDraft &&
        reimbursableSpend !== 0 &&
        !hasAllPendingRTERViolations &&
        !shouldShowBrokenConnectionViolation &&
        (moneyRequestReport?.ownerAccountID === currentUserAccountID || isAdmin || moneyRequestReport?.managerID === currentUserAccountID);

    const shouldShowExportIntegrationButton = !shouldShowPayButton && !shouldShowSubmitButton && connectedIntegration && isAdmin && canBeExported(moneyRequestReport);

    const shouldShowSettlementButton =
        (shouldShowPayButton || shouldShowApproveButton) && !hasAllPendingRTERViolations && !shouldShowExportIntegrationButton && !shouldShowBrokenConnectionViolation;

    const shouldDisableSubmitButton = shouldShowSubmitButton && !isAllowedToSubmitDraftExpenseReport(moneyRequestReport);
    const isFromPaidPolicy = policyType === CONST.POLICY.TYPE.TEAM || policyType === CONST.POLICY.TYPE.CORPORATE;
    const shouldShowStatusBar =
        hasAllPendingRTERViolations || shouldShowBrokenConnectionViolation || hasOnlyHeldExpenses || hasScanningReceipt || isPayAtEndExpense || hasOnlyPendingTransactions;
    const shouldShowNextStep = !isClosedExpenseReportWithNoExpenses(moneyRequestReport) && isFromPaidPolicy && !!nextStep?.message?.length && !shouldShowStatusBar;
    const shouldShowAnyButton =
        isDuplicate ||
        shouldShowSettlementButton ||
        shouldShowApproveButton ||
        shouldShowSubmitButton ||
        shouldShowNextStep ||
        shouldShowMarkAsCashButton ||
        shouldShowExportIntegrationButton;
    const bankAccountRoute = getBankAccountRoute(chatReport);
    const formattedAmount = convertToDisplayString(reimbursableSpend, moneyRequestReport?.currency);
    const {nonHeldAmount, fullAmount, hasValidNonHeldAmount} = getNonHeldAndFullAmount(moneyRequestReport, shouldShowPayButton);
    const isAnyTransactionOnHold = hasHeldExpensesReportUtils(moneyRequestReport?.reportID);
    const displayedAmount = isAnyTransactionOnHold && canAllowSettlement && hasValidNonHeldAmount ? nonHeldAmount : formattedAmount;
    const isMoreContentShown = shouldShowNextStep || shouldShowStatusBar || (shouldShowAnyButton && shouldUseNarrowLayout);
    const {isDelegateAccessRestricted} = useDelegateUserDetails();
    const [isNoDelegateAccessMenuVisible, setIsNoDelegateAccessMenuVisible] = useState(false);

    const isReportInRHP = route.name === SCREENS.SEARCH.REPORT_RHP;
    const shouldDisplaySearchRouter = !isReportInRHP || isSmallScreenWidth;

    const confirmPayment = useCallback(
        (type?: PaymentMethodType | undefined, payAsBusiness?: boolean) => {
            if (!type || !chatReport) {
                return;
            }
            setPaymentType(type);
            setRequestType(CONST.IOU.REPORT_ACTION_TYPE.PAY);
            if (isDelegateAccessRestricted) {
                setIsNoDelegateAccessMenuVisible(true);
            } else if (isAnyTransactionOnHold) {
                setIsHoldMenuVisible(true);
            } else if (isInvoiceReport(moneyRequestReport)) {
                payInvoice(type, chatReport, moneyRequestReport, payAsBusiness);
            } else {
                payMoneyRequest(type, chatReport, moneyRequestReport, true);
            }
        },
        [chatReport, isAnyTransactionOnHold, isDelegateAccessRestricted, moneyRequestReport],
    );

    const confirmApproval = () => {
        setRequestType(CONST.IOU.REPORT_ACTION_TYPE.APPROVE);
        if (isDelegateAccessRestricted) {
            setIsNoDelegateAccessMenuVisible(true);
        } else if (isAnyTransactionOnHold) {
            setIsHoldMenuVisible(true);
        } else {
            approveMoneyRequest(moneyRequestReport, true);
        }
    };

    const deleteTransaction = useCallback(() => {
        if (requestParentReportAction) {
            const iouTransactionID = isMoneyRequestAction(requestParentReportAction) ? getOriginalMessage(requestParentReportAction)?.IOUTransactionID : undefined;
            if (isTrackExpenseAction(requestParentReportAction)) {
                navigateBackToAfterDelete.current = deleteTrackExpense(moneyRequestReport?.reportID, iouTransactionID, requestParentReportAction, true);
            } else {
                navigateBackToAfterDelete.current = deleteMoneyRequest(iouTransactionID, requestParentReportAction, true);
            }
        }

        setIsDeleteRequestModalVisible(false);
    }, [moneyRequestReport?.reportID, requestParentReportAction, setIsDeleteRequestModalVisible]);

    const markAsCash = useCallback(() => {
        if (!requestParentReportAction) {
            return;
        }
        const iouTransactionID = isMoneyRequestAction(requestParentReportAction) ? getOriginalMessage(requestParentReportAction)?.IOUTransactionID : undefined;
        const reportID = transactionThreadReport?.reportID;

        if (!iouTransactionID || !reportID) {
            return;
        }
        markAsCashAction(iouTransactionID, reportID);
    }, [requestParentReportAction, transactionThreadReport?.reportID]);

    const getStatusIcon: (src: IconAsset) => React.ReactNode = (src) => (
        <Icon
            src={src}
            height={variables.iconSizeSmall}
            width={variables.iconSizeSmall}
            fill={theme.icon}
        />
    );

    const getStatusBarProps: () => MoneyRequestHeaderStatusBarProps | undefined = () => {
        if (isPayAtEndExpense) {
            if (!isArchivedReport) {
                return {icon: getStatusIcon(Expensicons.Hourglass), description: translate('iou.bookingPendingDescription')};
            }
            if (isArchivedReport && archiveReason === CONST.REPORT.ARCHIVE_REASON.BOOKING_END_DATE_HAS_PASSED) {
                return {icon: getStatusIcon(Expensicons.Box), description: translate('iou.bookingArchivedDescription')};
            }
        }
        if (hasOnlyHeldExpenses) {
            return {icon: getStatusIcon(Expensicons.Stopwatch), description: translate('iou.expensesOnHold')};
        }
        if (shouldShowBrokenConnectionViolation) {
            return {
                icon: getStatusIcon(Expensicons.Hourglass),
                description: (
                    <BrokenConnectionDescription
                        transactionID={transaction?.transactionID}
                        report={moneyRequestReport}
                        policy={policy}
                    />
                ),
            };
        }
        if (hasAllPendingRTERViolations) {
            return {icon: getStatusIcon(Expensicons.Hourglass), description: translate('iou.pendingMatchWithCreditCardDescription')};
        }
        if (hasOnlyPendingTransactions) {
            return {icon: getStatusIcon(Expensicons.CreditCardHourglass), description: translate('iou.transactionPendingDescription')};
        }
        if (hasScanningReceipt) {
            return {icon: getStatusIcon(Expensicons.ReceiptScan), description: translate('iou.receiptScanInProgressDescription')};
        }
    };

    const statusBarProps = getStatusBarProps();
    const shouldAddGapToContents =
        shouldUseNarrowLayout &&
        (isDuplicate || shouldShowSettlementButton || !!shouldShowExportIntegrationButton || shouldShowSubmitButton || shouldShowMarkAsCashButton) &&
        (!!statusBarProps || shouldShowNextStep);

    // The submit button should be success green colour only if the user is submitter and the policy does not have Scheduled Submit turned on
    const isWaitingForSubmissionFromCurrentUser = useMemo(
        () => chatReport?.isOwnPolicyExpenseChat && !policy?.harvesting?.enabled,
        [chatReport?.isOwnPolicyExpenseChat, policy?.harvesting?.enabled],
    );

    const shouldDuplicateButtonBeSuccess = useMemo(
        () => isDuplicate && !shouldShowSettlementButton && !shouldShowExportIntegrationButton && !shouldShowSubmitButton && !shouldShowMarkAsCashButton,
        [isDuplicate, shouldShowSettlementButton, shouldShowExportIntegrationButton, shouldShowSubmitButton, shouldShowMarkAsCashButton],
    );

    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        if (isLoadingHoldUseExplained || dismissedHoldUseExplanation || !isOnHold) {
            return;
        }
        Navigation.navigate(ROUTES.PROCESS_MONEY_REQUEST_HOLD.getRoute(Navigation.getReportRHPActiveRoute()));
    }, [dismissedHoldUseExplanation, isLoadingHoldUseExplained, isOnHold]);

    useEffect(() => {
        if (canDeleteRequest) {
            return;
        }

        setIsDeleteRequestModalVisible(false);
    }, [canDeleteRequest]);

    return (
        <View style={[styles.pt0]}>
            <HeaderWithBackButton
                shouldShowReportAvatarWithDisplay
                shouldEnableDetailPageNavigation
                shouldShowPinButton={false}
                report={moneyRequestReport}
                policy={policy}
                shouldShowBackButton={shouldUseNarrowLayout}
                shouldDisplaySearchRouter={shouldDisplaySearchRouter}
                onBackButtonPress={onBackButtonPress}
                // Shows border if no buttons or banners are showing below the header
                shouldShowBorderBottom={!isMoreContentShown}
            >
                {isDuplicate && !shouldUseNarrowLayout && (
                    <View style={[shouldDuplicateButtonBeSuccess ? styles.ml2 : styles.mh2]}>
                        <Button
                            success={shouldDuplicateButtonBeSuccess}
                            text={translate('iou.reviewDuplicates')}
                            style={styles.p0}
                            onPress={() => {
                                Navigation.navigate(ROUTES.TRANSACTION_DUPLICATE_REVIEW_PAGE.getRoute(transactionThreadReportID, Navigation.getReportRHPActiveRoute()));
                            }}
                        />
                    </View>
                )}
                {shouldShowSettlementButton && !shouldUseNarrowLayout && (
                    <View style={styles.pv2}>
                        <SettlementButton
                            shouldUseSuccessStyle={!hasHeldExpenses}
                            onlyShowPayElsewhere={onlyShowPayElsewhere}
                            currency={moneyRequestReport?.currency}
                            confirmApproval={confirmApproval}
                            policyID={moneyRequestReport?.policyID}
                            chatReportID={chatReport?.reportID}
                            iouReport={moneyRequestReport}
                            onPress={confirmPayment}
                            enablePaymentsRoute={ROUTES.ENABLE_PAYMENTS}
                            addBankAccountRoute={bankAccountRoute}
                            shouldHidePaymentOptions={!shouldShowPayButton}
                            shouldShowApproveButton={shouldShowApproveButton}
                            shouldDisableApproveButton={shouldDisableApproveButton}
                            style={[styles.pv2]}
                            formattedAmount={!hasOnlyHeldExpenses ? displayedAmount : ''}
                            isDisabled={isOffline && !canAllowSettlement}
                            isLoading={!isOffline && !canAllowSettlement}
                        />
                    </View>
                )}
                {!!shouldShowExportIntegrationButton && !shouldUseNarrowLayout && (
                    <View style={[styles.pv2]}>
                        <ExportWithDropdownMenu
                            policy={policy}
                            report={moneyRequestReport}
                            connectionName={connectedIntegration}
                        />
                    </View>
                )}
                {shouldShowSubmitButton && !shouldUseNarrowLayout && (
                    <View style={styles.pv2}>
                        <Button
                            success={isWaitingForSubmissionFromCurrentUser}
                            text={translate('common.submit')}
                            style={[styles.mnw120, styles.pv2, styles.pr0]}
                            onPress={() => submitReport(moneyRequestReport)}
                            isDisabled={shouldDisableSubmitButton}
                        />
                    </View>
                )}
                {shouldShowMarkAsCashButton && !shouldUseNarrowLayout && (
                    <View style={[styles.pv2]}>
                        <Button
                            success
                            text={translate('iou.markAsCash')}
                            style={[styles.pv2, styles.pr0]}
                            onPress={markAsCash}
                        />
                    </View>
                )}
            </HeaderWithBackButton>
            {!!isMoreContentShown && (
                <View style={[styles.dFlex, styles.flexColumn, shouldAddGapToContents && styles.gap3, styles.pb3, styles.ph5, styles.borderBottom]}>
                    <View style={[styles.dFlex, styles.w100, styles.flexRow, styles.gap3]}>
                        {isDuplicate && shouldUseNarrowLayout && (
                            <Button
                                success={shouldDuplicateButtonBeSuccess}
                                text={translate('iou.reviewDuplicates')}
                                style={[styles.flex1, styles.pr0]}
                                onPress={() => {
                                    Navigation.navigate(ROUTES.TRANSACTION_DUPLICATE_REVIEW_PAGE.getRoute(transactionThreadReportID, Navigation.getReportRHPActiveRoute()));
                                }}
                            />
                        )}
                        {shouldShowSettlementButton && shouldUseNarrowLayout && (
                            <SettlementButton
                                shouldUseSuccessStyle={!hasHeldExpenses}
                                wrapperStyle={[styles.flex1]}
                                onlyShowPayElsewhere={onlyShowPayElsewhere}
                                currency={moneyRequestReport?.currency}
                                confirmApproval={confirmApproval}
                                policyID={moneyRequestReport?.policyID}
                                chatReportID={moneyRequestReport?.chatReportID}
                                iouReport={moneyRequestReport}
                                onPress={confirmPayment}
                                enablePaymentsRoute={ROUTES.ENABLE_PAYMENTS}
                                addBankAccountRoute={bankAccountRoute}
                                shouldHidePaymentOptions={!shouldShowPayButton}
                                shouldShowApproveButton={shouldShowApproveButton}
                                formattedAmount={!hasOnlyHeldExpenses ? displayedAmount : ''}
                                shouldDisableApproveButton={shouldDisableApproveButton}
                                isDisabled={isOffline && !canAllowSettlement}
                                isLoading={!isOffline && !canAllowSettlement}
                            />
                        )}
                        {!!shouldShowExportIntegrationButton && shouldUseNarrowLayout && (
                            <ExportWithDropdownMenu
                                policy={policy}
                                report={moneyRequestReport}
                                connectionName={connectedIntegration}
                            />
                        )}
                        {shouldShowSubmitButton && shouldUseNarrowLayout && (
                            <Button
                                success={isWaitingForSubmissionFromCurrentUser}
                                text={translate('common.submit')}
                                style={[styles.flex1, styles.pr0]}
                                onPress={() => submitReport(moneyRequestReport)}
                                isDisabled={shouldDisableSubmitButton}
                            />
                        )}
                        {shouldShowMarkAsCashButton && shouldUseNarrowLayout && (
                            <Button
                                success
                                text={translate('iou.markAsCash')}
                                style={[styles.flex1, styles.pr0]}
                                onPress={markAsCash}
                            />
                        )}
                    </View>
                    {shouldShowNextStep && <MoneyReportHeaderStatusBar nextStep={nextStep} />}
                    {!!statusBarProps && (
                        <MoneyRequestHeaderStatusBar
                            icon={statusBarProps.icon}
                            description={statusBarProps.description}
                        />
                    )}
                </View>
            )}
            {isHoldMenuVisible && requestType !== undefined && (
                <ProcessMoneyReportHoldMenu
                    nonHeldAmount={!hasOnlyHeldExpenses && hasValidNonHeldAmount ? nonHeldAmount : undefined}
                    requestType={requestType}
                    fullAmount={fullAmount}
                    onClose={() => setIsHoldMenuVisible(false)}
                    isVisible={isHoldMenuVisible}
                    paymentType={paymentType}
                    chatReport={chatReport}
                    moneyRequestReport={moneyRequestReport}
                    transactionCount={transactionIDs.length}
                />
            )}
            <DelegateNoAccessModal
                isNoDelegateAccessMenuVisible={isNoDelegateAccessMenuVisible}
                onClose={() => setIsNoDelegateAccessMenuVisible(false)}
            />

            <ConfirmModal
                title={translate('iou.deleteExpense', {count: 1})}
                isVisible={isDeleteRequestModalVisible}
                onConfirm={deleteTransaction}
                onCancel={() => setIsDeleteRequestModalVisible(false)}
                onModalHide={() => navigateBackOnDeleteTransaction(navigateBackToAfterDelete.current)}
                prompt={translate('iou.deleteConfirmation', {count: 1})}
                confirmText={translate('common.delete')}
                cancelText={translate('common.cancel')}
                danger
                shouldEnableNewFocusManagement
            />
        </View>
    );
}

MoneyReportHeader.displayName = 'MoneyReportHeader';

export default MoneyReportHeader;
