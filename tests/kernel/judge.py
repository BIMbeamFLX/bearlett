# lnurlcash-kernel (Bitcoin Core's own interpreter, libbitcoinkernel) judges
# every spend tests/kernel/cases.ts built with Bearlett's spec core, and the
# two verdicts must agree. Run by CI on Linux, where the kernel has wheels.
import json
import sys

import lnurlcashkernel as k

cases = json.load(open(sys.argv[1]))
mismatches = 0
for case in cases:
    try:
        spend = k.decode_spend(case['k1'])
        if spend is None:
            verdict = 'undecodable'
        else:
            k.verify_spend(
                output_key=bytes.fromhex(case['q']),
                domain=case['domain'],
                spend=spend,
                now=case['now'],
                locked_at=case['lockedAt'],
            )
            verdict = 'valid'
    except k.TimeClaimRejected:
        verdict = 'time'
    except (k.SpendRejected, k.ScriptInvalid):
        verdict = 'invalid'
    except k.UnsupportedScript as err:
        verdict = f'unsupported ({err})'
    agree = verdict == case['ours'] or (verdict == 'invalid' and case['ours'] == 'invalid')
    if not agree:
        mismatches += 1
    print(f"{'ok  ' if agree else 'DIFF'} kernel={verdict:<11} ours={case['ours']:<11} {case['name']}")
print(f'\n{mismatches} mismatches' if mismatches else '\nkernel and Bearlett agree on every case')
print('kernel', k.UPSTREAM_TAG, k.UPSTREAM_COMMIT[:12])
sys.exit(1 if mismatches else 0)
