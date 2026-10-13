// Export protection for StateTrace (see LICENSE).
// Copyright (c) 2019-2026 Nafees Mansoor, MIT License.
//
// The one place where PNG and SVG exports are made. Every exported image carries the
// signature "Copyright Nafees Mansoor" in a strip of its own under the drawing, and an
// export that cannot be signed and checked is refused. The signature is never drawn on
// the board and never stored in the machine.
//
// This runs in the visitor's browser from public source, so it guards against mistakes
// and casual removal, not against someone who edits the code. scripts/check-exports.mjs
// and tests/export-protection.test.mjs keep the rest of the code from going around it.
var ExportProtection = (function() {
	var SIGNATURE = 'Copyright Nafees Mansoor';
	var SIGNATURE_ID = 'statetrace-signature';
	var FONT_FAMILY = "Georgia, 'Times New Roman', Times, serif";
	var WIDTH_EM = 13; // the signature is never wider than this many times its font size
	var MIN_FONT = 6;
	var MAX_FONT = 40;
	var PNG_HEADER = [137, 80, 78, 71, 13, 10, 26, 10];
	var PNG_PREFIX = 'data:image/png;base64,';

	// the last artifact made here for each format; verify() accepts nothing else
	var issued = { 'png': null, 'svg': null };

	function refuse(reason) {
		throw new Error('Export blocked: ' + reason);
	}

	function trim(number) {
		return number.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
	}

	// where the signature goes for a drawing of this size, in the drawing's own units:
	// a strip `band` tall is added under the drawing and the text sits at its right end
	function layout(width, height) {
		if(!(width > 0) || !(height > 0) || !isFinite(width) || !isFinite(height)) {
			refuse('the drawing has no size.');
		}
		var fontSize = Math.max(11, Math.min(MAX_FONT, Math.sqrt(width * height) * 0.024));
		// a narrow drawing gets smaller text instead of clipped or wrapped text
		fontSize = Math.min(fontSize, width / (WIDTH_EM + 1.8));
		if(fontSize < MIN_FONT) {
			refuse('the drawing is too narrow to carry the signature.');
		}
		var padding = fontSize * 0.9;
		var band = Math.ceil(fontSize * 2.1);
		return { 'fontSize': fontSize, 'padding': padding, 'band': band, 'right': width - padding, 'baseline': height + band - padding };
	}

	// ---- SVG ----

	function viewBoxOf(tag) {
		var match = /\sviewBox="([^"]*)"/.exec(tag);
		var box = match ? match[1].trim().split(/[\s,]+/).map(Number) : [];
		if(box.length != 4 || !box.every(isFinite) || !(box[2] > 0) || !(box[3] > 0)) {
			refuse('the SVG has no usable viewBox.');
		}
		return { 'x': box[0], 'y': box[1], 'width': box[2], 'height': box[3] };
	}

	function rootTagOf(text) {
		var match = /<svg\s[^>]*>/.exec(text);
		if(typeof text != 'string' || !match || !/<\/svg>\s*$/.test(text)) {
			refuse('this is not an SVG image.');
		}
		return match[0];
	}

	function attributesOf(source) {
		var attributes = {};
		var count = 0;
		source.replace(/([\w-]+)="([^"]*)"/g, function(all, name, value) {
			attributes[name] = value;
			count++;
		});
		attributes.count = count;
		return attributes;
	}

	// checks that the image ends with the signature, unhidden and inside the picture; throws if not
	function inspectSVG(text) {
		var box = viewBoxOf(rootTagOf(text));
		if(text.split('id="' + SIGNATURE_ID + '"').length != 2) {
			refuse('the SVG does not carry exactly one signature.');
		}
		// last in the file, so nothing in the drawing is painted over it
		var match = new RegExp('<g id="' + SIGNATURE_ID + '">\\s*<text ([^>]*)>([^<]*)</text>\\s*</g>\\s*</svg>\\s*$').exec(text);
		if(!match || match[2] !== SIGNATURE) {
			refuse('the SVG signature is missing or altered.');
		}
		var attributes = attributesOf(match[1]);
		var x = Number(attributes['x']), y = Number(attributes['y']), fontSize = Number(attributes['font-size']);
		// exactly the attributes written by signSVG: nothing that could hide, move or recolour the text
		if(attributes.count != 7 || attributes['text-anchor'] != 'end' || attributes['font-family'] != FONT_FAMILY ||
				attributes['font-style'] != 'italic' || !/^#[0-9a-f]{6}$/.test(attributes['fill'])) {
			refuse('the SVG signature is not styled as it was written.');
		}
		if(!(fontSize >= MIN_FONT) || !(x <= box.x + box.width) || !(x - WIDTH_EM * fontSize >= box.x) ||
				!(y - fontSize >= box.y) || !(y + fontSize * 0.3 <= box.y + box.height)) {
			refuse('the SVG signature does not fit inside the image.');
		}
		if(typeof DOMParser != 'undefined' && new DOMParser().parseFromString(text, 'image/svg+xml').getElementsByTagName('parsererror').length > 0) {
			refuse('the signed SVG is not well formed.');
		}
		return { 'x': x, 'y': y, 'fontSize': fontSize, 'viewBox': box };
	}

	function signSVG(text) {
		var tag = rootTagOf(text);
		var box = viewBoxOf(tag);
		if(text.indexOf(SIGNATURE_ID) != -1) {
			refuse('the SVG is already signed.');
		}
		var place = layout(box.width, box.height);
		var grown = (box.height + place.band) / box.height;
		var newTag = tag.replace(/(\sviewBox=")[^"]*"/, '$1' + trim(box.x) + ' ' + trim(box.y) + ' ' + trim(box.width) + ' ' + trim(box.height + place.band) + '"');
		// keep the drawing at the scale it had: the image only gets taller
		newTag = newTag.replace(/(\sheight=")(\d+(?:\.\d+)?)"/, function(all, name, value) {
			return name + trim(Number(value) * grown) + '"';
		});
		var signature = '\t<g id="' + SIGNATURE_ID + '">\n' +
			'\t\t<text x="' + trim(box.x + place.right) + '" y="' + trim(box.y + place.baseline) + '" text-anchor="end" font-family="' + FONT_FAMILY +
			'" font-style="italic" font-size="' + trim(place.fontSize) + '" fill="#555555">' + SIGNATURE + '</text>\n' +
			'\t</g>\n';
		var end = text.lastIndexOf('</svg>');
		return text.slice(0, end).replace(tag, function() { return newTag; }) + signature + text.slice(end);
	}

	// the only way an SVG leaves the app: takes the drawing, returns it signed, or throws
	function svg(drawing) {
		var signed = signSVG(drawing);
		inspectSVG(signed);
		issued.svg = signed;
		return signed;
	}

	// ---- PNG ----

	var crcTable = null;

	function crc32(bytes, start, end) {
		if(crcTable == null) {
			crcTable = [];
			for(var n = 0; n < 256; n++) {
				var value = n;
				for(var k = 0; k < 8; k++) {
					value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
				}
				crcTable[n] = value >>> 0;
			}
		}
		var crc = 0xFFFFFFFF;
		for(var i = start; i < end; i++) {
			crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
		}
		return (crc ^ 0xFFFFFFFF) >>> 0;
	}

	function uint32(bytes, at) {
		return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
	}

	function putUint32(bytes, at, value) {
		bytes[at] = value >>> 24;
		bytes[at + 1] = (value >>> 16) & 0xFF;
		bytes[at + 2] = (value >>> 8) & 0xFF;
		bytes[at + 3] = value & 0xFF;
	}

	function ascii(bytes, start, end) {
		var text = '';
		for(var i = start; i < end; i++) {
			text += String.fromCharCode(bytes[i]);
		}
		return text;
	}

	function bytesOfDataURL(url) {
		if(typeof url != 'string' || url.indexOf(PNG_PREFIX) != 0) {
			refuse('the browser did not produce a PNG image.');
		}
		var binary = atob(url.slice(PNG_PREFIX.length));
		var bytes = new Uint8Array(binary.length);
		for(var i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	function dataURLOfBytes(bytes) {
		var binary = '';
		for(var i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		return PNG_PREFIX + btoa(binary);
	}

	// reads the file chunk by chunk: it has to be an intact PNG whose Copyright field is the signature
	function inspectPNG(bytes) {
		for(var i = 0; i < PNG_HEADER.length; i++) {
			if(bytes[i] !== PNG_HEADER[i]) refuse('the image is not a PNG file.');
		}
		var at = PNG_HEADER.length;
		var names = [];
		var size = null;
		var copyright = 0;
		while(at + 12 <= bytes.length) {
			var length = uint32(bytes, at);
			var name = ascii(bytes, at + 4, at + 8);
			var end = at + 8 + length;
			if(end + 4 > bytes.length || crc32(bytes, at + 4, end) !== uint32(bytes, end)) {
				refuse('the PNG file is damaged.');
			}
			if(name == 'IHDR') {
				size = { 'width': uint32(bytes, at + 8), 'height': uint32(bytes, at + 12) };
			} else if(name == 'tEXt' && ascii(bytes, at + 8, end) === 'Copyright\0' + SIGNATURE) {
				copyright++;
			}
			names.push(name);
			at = end + 4;
		}
		if(at != bytes.length || names[0] != 'IHDR' || names[names.length - 1] != 'IEND' || size == null) {
			refuse('the PNG file is damaged.');
		}
		if(copyright != 1) {
			refuse('the PNG does not carry the copyright field.');
		}
		return size;
	}

	// writes the signature into the file's own Copyright field, straight after the header chunk
	function stampPNG(bytes) {
		var text = 'Copyright\0' + SIGNATURE;
		var chunk = new Uint8Array(12 + text.length);
		putUint32(chunk, 0, text.length);
		chunk.set([116, 69, 88, 116], 4); // tEXt
		for(var i = 0; i < text.length; i++) {
			chunk[8 + i] = text.charCodeAt(i);
		}
		putUint32(chunk, 8 + text.length, crc32(chunk, 4, 8 + text.length));
		var headerEnd = PNG_HEADER.length + 12 + uint32(bytes, PNG_HEADER.length);
		var stamped = new Uint8Array(bytes.length + chunk.length);
		stamped.set(bytes.subarray(0, headerEnd), 0);
		stamped.set(chunk, headerEnd);
		stamped.set(bytes.subarray(headerEnd), headerEnd + chunk.length);
		return stamped;
	}

	// light text on a dark strip, dark on a light one, and a mid grey when there is no background
	function inkFor(pixel) {
		if(pixel[3] < 128) return '#808898';
		return 0.299 * pixel[0] + 0.587 * pixel[1] + 0.114 * pixel[2] < 128 ? '#aab4cc' : '#555555';
	}

	// the only way a PNG leaves the app: takes the finished drawing on a canvas and returns a
	// data URL of it with the signature strip added, or throws.
	// options.scale is device pixels per drawing unit; options.background fills behind the drawing.
	function png(drawing, options) {
		options = options || {};
		var scale = options.scale > 0 ? options.scale : 1;
		if(typeof document == 'undefined' || !drawing || typeof drawing.getContext != 'function') {
			refuse('there is no canvas to export.');
		}
		var place = layout(drawing.width / scale, drawing.height / scale);
		var band = Math.ceil(place.band * scale);
		var padding = place.padding * scale;
		var image = document.createElement('canvas');
		image.width = drawing.width;
		image.height = drawing.height + band;
		var c = image.getContext('2d');
		if(c == null) {
			refuse('the browser could not make the image.');
		}
		if(options.background) {
			c.fillStyle = options.background;
			c.fillRect(0, 0, image.width, image.height);
		}
		c.drawImage(drawing, 0, 0);

		var before = c.getImageData(0, drawing.height, image.width, band).data;
		var fontSize = place.fontSize * scale;
		c.font = 'italic ' + fontSize + 'px ' + FONT_FAMILY;
		var measured = c.measureText(SIGNATURE).width;
		if(measured > image.width - 2 * padding) {
			fontSize *= (image.width - 2 * padding) / measured;
			c.font = 'italic ' + fontSize + 'px ' + FONT_FAMILY;
		}
		c.textAlign = 'right';
		c.textBaseline = 'alphabetic';
		c.fillStyle = inkFor(before);
		c.fillText(SIGNATURE, image.width - padding, image.height - padding);

		// the text has to have really landed on the strip
		var after = c.getImageData(0, drawing.height, image.width, band).data;
		var inked = 0;
		for(var i = 0; i < after.length; i += 4) {
			if(after[i] != before[i] || after[i + 1] != before[i + 1] || after[i + 2] != before[i + 2] || after[i + 3] != before[i + 3]) inked++;
		}
		if(inked < fontSize * 4) {
			refuse('the signature could not be drawn.');
		}

		var bytes = stampPNG(bytesOfDataURL(image.toDataURL('image/png')));
		var size = inspectPNG(bytes);
		if(size.width != image.width || size.height != image.height) {
			refuse('the PNG is not the size it was drawn at.');
		}
		issued.png = dataURLOfBytes(bytes);
		return issued.png;
	}

	// ---- the last check before an export is downloaded or copied ----

	// throws unless the artifact is the one made here, still signed
	function verify(format, artifact) {
		if(format != 'png' && format != 'svg') {
			refuse('unknown image format.');
		}
		if(typeof artifact != 'string' || artifact === '' || issued[format] !== artifact) {
			refuse('the image did not come from the signed export.');
		}
		if(format == 'png') {
			inspectPNG(bytesOfDataURL(artifact));
		} else {
			inspectSVG(artifact);
		}
		return true;
	}

	return Object.freeze({
		'SIGNATURE': SIGNATURE,
		'SIGNATURE_ID': SIGNATURE_ID,
		'layout': layout,
		'svg': svg,
		'png': png,
		'verify': verify,
		'inspectSVG': inspectSVG,
		'inspectPNG': inspectPNG,
		'stampPNG': stampPNG,
	});
})();
