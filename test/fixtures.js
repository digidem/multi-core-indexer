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
  '0d/e6/0de69aa84a5a578fd60de202cc47f67859e6b9783214dc837336e8b5f7089d80',
  '2a/74/2a742a11bf74974ecb2a7944aba63603a57b810b992be02e3298e32be3b060b0',
  '2f/de/2fde7bfd70c11cdd4a01525d686a83bd2413258e6862ad79d785921c95c2f244',
  '50/ff/50ff066893c283151b555599d775b9582e125481fe65bbc9617512073611fda7',
  '58/0c/580c343a8b0cc548a966bd9dcb8648c3cb0d1784273859626f4e5071e467f94e',
  '8d/f0/8df0f9ab032e9b20c92b5f6b5dcd0cd9eaffc365e4ee70bc3f4dc2e895e26d0f',
  '9a/4d/9a4de587d36c11e4bd3b05db4615211bff1efeeee76d3b42eaa10fc0e10b3ac7',
  'ab/fd/abfdc6e36f07c8783520f27c9f26cf31882f732fce837dceaef7f65536b4fc68',
  'b8/e0/b8e09d78aab38c8a54d2060e158fa784eb9232e30abe675f935745cd3ec3f3f5',
  'f3/ee/f3eee8e01992aa3cdc5927a672d4004a7ccc01845b2afa5ebac9d48893f56ef9',
]
