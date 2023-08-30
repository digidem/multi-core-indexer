const sodium = require('sodium-native')

function generateKeypair(index) {
  const seed = Buffer.alloc(sodium.crypto_sign_SEEDBYTES)
  sodium.crypto_generichash(seed, Buffer.from('test_seed' + index))
  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  return { publicKey, secretKey }
}

exports.testKeypairs = Array(10)
  .fill(null)
  .map((_, i) => generateKeypair(i))

// Given the deterministic keypairs above, these are the expected storage keys
exports.expectedStorageNames = [
  '1e/2e/1e2ea00940e04dc2e7d7abb8ed6124eda065002286171f6ccd3d2a0bae032405',
  '2d/17/2d174b46cf4d2f2abaedde8f145ea353fa99dca21857fd68bbeed88dc2ddc01d',
  '4b/eb/4beb8496362d3e6b84437e9064d38d881147160dbbc8036713b55e1e5ad7341c',
  '7b/12/7b129cde6d29f767a6e0be0721dede6b3059ec809eca8727c68cf8abdc13a0ec',
  '93/61/936183470a9fab3f967adffaf88dd28a7a7b4dcc8eb6658c3353e66ed8f4057c',
  'd2/51/d251952cf9f04b07daac716f789c63c9fbbbad7f12f123e64b4b0b8124fe53f9',
  'd9/0d/d90d7456d6131d9d290927d8ada3ec380583fc2549608ee75e9ca71d1c1a289f',
  'e5/f4/e5f42a42b81487713167f7221ce002fd66ed17b67dd01a7cdb98a6f7d914000f',
  'f3/9a/f39a94012f3819f3a9bd93136857525e5ba435e02d581d5c02a9625eb3ff6299',
  'f4/36/f436bbbfb635e20eca2f01aba1f8483761d0c6cb3372e3f91dfc55b62996a932',
]
