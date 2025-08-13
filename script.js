// 100 bytes total encoded bit-per pixel require minimum 800 pixels image
// (e.g. 30x30 ok, 28x28 not ok)
// 32-byte r, 32-byte s, 1 byte b
const sig_len = (32 + 32 + 1)
const addr_len = 20
const handle_len = 15
const sig_index = 0

// srgb is not what you think: 0 for r, 1 for g, 2 for b and 3 for alpha
// must use the alpha channel, otherwise putImageData will not write pixels with 0 alpha in them
let channel = 3

el_file.addEventListener('change', (event) => {
  const file = event.target.files[0];
  const reader = new FileReader();

  el_img.src = ''
  reader.onload = (event) => {
    el_img.src = event.target.result;
  };

  reader.readAsDataURL(file);
});

function redrawImage() {
  const ctx = getContext(canvas)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  canvas.width = el_img.width
  canvas.height = el_img.height
  
  // ensure image is drawn onto canvas
  ctx.drawImage(el_img, 0, 0)
}

async function fetchBlob(url) {
    const response = await fetch(url);
    return response.blob();
}

function allowDrop(ev) {
  ev.preventDefault();
}

function drag(ev) {
  ev.dataTransfer.setData("text", ev.target.id);
}

function getContext(canvas) {
  return canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
}

function drop(ev) {
  ev.preventDefault();
  
  let img_url = ev.dataTransfer.getData("text");
  if (img_url) {
    fetchBlob(img_url).then((blob) => {
      el_img.src = URL.createObjectURL(blob)
    })
  } else if (event.dataTransfer.files.length > 0) {
    const file = event.dataTransfer.files[0];
    const reader = new FileReader();
    reader.onload = function() {
      el_img.src = reader.result;
    }
    reader.readAsDataURL(file);
  }
}

// encodes image_data inplace
function encode(image, data, count, index=0) {
  let hex_data = ethers.utils.hexlify(data)
  if (!count)
    count = parseInt((hex_data.length - 2) / 2)

  let num_bits = count * 8
  let big_num = BigInt(hex_data)
  for (let i = 0; i < num_bits; i++) {
    // (base index + pixel index) * 4 srgb channels + offset for channel
    let ptr = (index * 8 + i) * 4 + channel
    const color = image.data[ptr]

    // encode in the LSBit of the green channel
    image.data[ptr] = (color & ~1) | parseInt(big_num % 2n)
    big_num /= 2n
  }
}

// returns hexlify'd data
function decode(image, count, index=0) {
  let data = 0n
  for (let i = 0; i < count * 8; i++) {
    let ptr = (index * 8 + i) * 4 + channel
    if (image.data[ptr] % 2 == 1)
      data |= (2n ** BigInt(i))
  }

  return '0x' + (data.toString(16).padStart(count * 2, '0'))
}
  
function isValidHandle(handle) {
  return handle.match(/^[a-zA-Z0-9_]+ *$/)
}
  
async function getUserSigner() {
  const provider = new ethers.providers.Web3Provider(window.ethereum);
  let accounts = await window.ethereum.request({ method: "eth_requestAccounts" })
  const signer = await provider.getSigner(accounts[0])
  return signer
}
  
async function getDemoSigner() {
  return new ethers.Wallet('0x1234123412341234123412341234123412341234123412341234123412341234')
}

async function signImage(demo) {
  let handle_str = el_handle.value
  if (!isValidHandle(handle_str)) {
    alert('must have valid handle!')
    return
  }
  
  let signer
  if (demo)
    signer = await getDemoSigner()
  else
    signer = await getUserSigner()
    
  const signer_addr = await signer.getAddress()
  
  redrawImage()
  
  const ctx = getContext(canvas)
  let image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    
  // little optimization to only write modified rows of pixels
  let num_pixels = (sig_len + addr_len + handle_len) * 8
  let num_rows = parseInt(num_pixels / canvas.width) + 1
  
  // TODO: make sure image data is indeed 4 channels?
  let empty_sig = Array(sig_len).fill(0)
  let handle_data = Array(handle_len).fill(0).map((a, i) => handle_str.charCodeAt(i) || 0x20)

  // encode zeros for signature so decoder has canonical representation basis
  encode(image, empty_sig, sig_len, sig_index)
  encode(image, signer_addr, addr_len, sig_index + sig_len)
  encode(image, handle_data, handle_len, sig_index + addr_len + sig_len)
  
  // FUCKING BUG!!!!!
  // canvas will DESTROY pixels in very unpredictable way (even power of 2 square images will be obliterated)
  // so have to first let canvas do its carnage and only then proceed normally
  ctx.putImageData(image, 0, 0)
  // this is the optimized version; removing this to avoid chance of this bug reoccuring
  // ctx.putImageData(image, 0, 0, 0, 0, canvas.width, num_rows)
  image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  
  // sign the image with zero sig & handle encoded into it
  const message = image.data
  const signature = await signer.signMessage(message);
  //console.log('signature:', signature)

  const verify_addr = ethers.utils.verifyMessage(message, signature)
  if (verify_addr.toLowerCase() != signer_addr.toLowerCase()) {
    alert('error signing image! :(')
    return
  }
  
  // now encode the signature into the image
  encode(image, signature, sig_len, sig_index)

  let verify_signature = decode(image, sig_len, sig_index)
  if (verify_signature.toLowerCase() != signature.toLowerCase()) {
    alert('failed encoding signature! :(')
    return
  }

  //ctx.putImageData(image, 0, 0, 0, 0, canvas.width, num_rows)
  // taking unoptimized path: see comment above...
  ctx.putImageData(image, 0, 0)
  
  let verified = await verifyImage()
  //if (!verified)
  //  alert('error verified image! :(')
}

async function verifyImage() {
  try {
    const ctx = getContext(canvas)
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)

    let hex_handle = decode(image, handle_len, sig_index + addr_len + sig_len)
    let handle = Array.from(ethers.utils.arrayify(hex_handle)).map((i) => String.fromCharCode(i)).join('')
    if (!isValidHandle(handle))
        throw 'no handle'

    let hex_addr = decode(image, addr_len, sig_index + sig_len).toLowerCase()
    let signature = decode(image, sig_len, sig_index)
    //console.log('signature', signature)
    
    // restore image to canonicalized form
    let empty_sig = Array(sig_len).fill(0)
    encode(image, empty_sig, sig_len, sig_index)
    const message = image.data

    handle = handle.trimEnd()
    const signer_addr = ethers.utils.verifyMessage(message, signature)
    
    el_signerHandle.innerText = handle
    el_signerAddress.href = `https://etherscan.io/address/${signer_addr}`
    el_signerHandle.href = `https://twitter.com/${handle}`
    el_signerAddress.innerText = signer_addr
    
    if (signer_addr.toLowerCase() != hex_addr) {
      //alert(`WARNING: image encodes signer ${hex_addr}, but actually signed by ${signer_addr.toLowerCase()}`)
      el_signerAddress.innerText = 'mismatched! ⚠️ ' + signer_addr
      return false
    }

    return true
  } catch {
    //alert(`signature verification failed!\nattempt to read handle: ${handle}`)
    el_signerAddress.innerText = 'N/A'
    el_signerAddress.href = '#'
    el_signerHandle.innerText = 'N/A'
    el_signerHandle.href = '#'
    return false
  }
}

function onImageDownload() {
  let handle = el_signerHandle.innerText
  let signer_addr = el_signerAddress.innerText
  if (signer_addr == 'N/A') {
    alert('invalid signed image')
    return
  }
  
  const link = document.createElement('a');
  link.download = `signed-${handle}-${signer_addr}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}
