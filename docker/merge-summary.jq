# Two inputs (slurped): previous aggregate and the most recent bot attempt.
# The bot may run only a subset of accounts on retry. Keep earlier accounts and
# add newly earned points for the retried account rather than losing old data.
.[0] as $previous |
.[1] as $latest |
(reduce ($latest.accounts // [])[] as $new
    (($previous.accounts // []);
       ($new.email | ascii_downcase) as $id |
       if any(.[]; (.email | ascii_downcase) == $id) then
           map(if (.email | ascii_downcase) == $id then
                   . + {status: $new.status,
                        error: $new.error,
                        collectedPoints: ((.collectedPoints // 0) + ($new.collectedPoints // 0))}
               else . end)
       else . + [$new] end
    )) as $accounts |
$latest + {
    accounts: $accounts,
    attempts: (($previous.attempts // 0) + 1),
    totalCollectedPoints: ([$accounts[] | .collectedPoints // 0] | add // 0),
    failedEmails: [$accounts[] | select(.status == "failed") | .email],
    botWarningEmails: [$accounts[] | select(.status == "skipped_bot_warning") | .email],
    exitCode: (if any($accounts[]; .status == "failed") then 2 else 0 end)
}
