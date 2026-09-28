// The BOLT-11 fields a wallet remembers a payment by (src/lnurl/bolt11.ts),
// read from the examples of BOLT #11 (lightning/bolts 11-payment-encoding.md).
import {describe, expect, it} from 'vitest'
import {invoiceTerms} from '../../src/lnurl/bolt11.ts'

const HASH = '0001020304050607080900010203040506070809000102030405060708090102'

describe('the terms of a BOLT-11 invoice', () => {
  it('reads the payment hash, the timestamp and the default expiry', () => {
    expect(
      invoiceTerms(
        'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql'
      )
    ).toEqual({
      paymentHash: HASH,
      timestamp: 1496314658,
      expiry: 3600
    })
  })

  it('reads an expiry the invoice names', () => {
    expect(
      invoiceTerms(
        'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'
      )
    ).toEqual({
      paymentHash: HASH,
      timestamp: 1496314658,
      expiry: 60
    })
    expect(
      invoiceTerms(
        'lnbc9678785340p1pwmna7lpp5gc3xfm08u9qy06djf8dfflhugl6p7lgza6dsjxq454gxhj9t7a0sd8dgfkx7cmtwd68yetpd5s9xar0wfjn5gpc8qhrsdfq24f5ggrxdaezqsnvda3kkum5wfjkzmfqf3jkgem9wgsyuctwdus9xgrcyqcjcgpzgfskx6eqf9hzqnteypzxz7fzypfhg6trddjhygrcyqezcgpzfysywmm5ypxxjemgw3hxjmn8yptk7untd9hxwg3q2d6xjcmtv4ezq7pqxgsxzmnyyqcjqmt0wfjjq6t5v4khxsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsxqyjw5qcqp2rzjq0gxwkzc8w6323m55m4jyxcjwmy7stt9hwkwe2qxmy8zpsgg7jcuwz87fcqqeuqqqyqqqqlgqqqqn3qq9q9qrsgqrvgkpnmps664wgkp43l22qsgdw4ve24aca4nymnxddlnp8vh9v2sdxlu5ywdxefsfvm0fq3sesf08uf6q9a2ke0hc9j6z6wlxg5z5kqpu2v9wz'
      )
    ).toEqual({
      paymentHash:
        '462264ede7e14047e9b249da94fefc47f41f7d02ee9b091815a5506bc8abf75f',
      timestamp: 1572468703,
      expiry: 604800
    })
  })

  it('reads an invoice however it is written', () => {
    const upper =
      'LNBC25M1PVJLUEZPP5QQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQYPQDQ5VDHKVEN9V5SXYETPDEESSP5ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYGS9Q5SQQQQQQQQQQQQQQQQSGQ2A25DXL5HRNTDTN6ZVYDT7D66HYZSYHQS4WDYNAVYS42XGL6SGX9C4G7ME86A27T07MDTFRY458RTJR0V92CNMSWPSJSCGT2VCSE3SGPZ3UAPA'
    expect(invoiceTerms(upper)?.paymentHash).toBe(HASH)
    expect(invoiceTerms(`lightning:${upper.toLowerCase()}`)?.paymentHash).toBe(
      HASH
    )
  })

  it('reads nothing from what is not an invoice', () => {
    for (const text of [
      '',
      'lnbc100n1' + 'q'.repeat(52),
      'cp1qqqq',
      'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rx'
    ])
      expect(invoiceTerms(text)).toBeNull()
  })
})
