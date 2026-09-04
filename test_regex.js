const r = /\b(mark (this |this case |the case |it )?(as )?(resolved|closed)|mark resolved|mark closed)\b/i;
console.log('mark this as resolved:', r.test('mark this as resolved'));
console.log('mark this case as resolved:', r.test('mark this case as resolved'));
