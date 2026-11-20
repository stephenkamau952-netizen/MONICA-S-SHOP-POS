const Calculator = require('./calculator');

describe('Calculator', () => {
  let calculator;

  beforeEach(() => {
    calculator = new Calculator();
  });

  test('performs the basic arithmetic operations', () => {
    expect(calculator.add(2, 3)).toBe(5);
    expect(calculator.subtract(7, 4)).toBe(3);
    expect(calculator.multiply(3, 4)).toBe(12);
    expect(calculator.divide(8, 2)).toBe(4);
  });

  test('toggles the sign of a nonzero value', () => {
    calculator.appendNumber(5);
    expect(calculator.toggleSign()).toBe('-5');
    expect(calculator.toggleSign()).toBe('5');
  });

  test('converts a value to a percentage', () => {
    calculator.appendNumber(2);
    calculator.appendNumber(5);
    expect(calculator.percent()).toBe('0.25');
  });

  test('uses the first value as the base for addition percentages', () => {
    calculator.appendNumber(1);
    calculator.appendNumber(0);
    calculator.appendNumber(0);
    calculator.setOperator('+');
    calculator.appendNumber(1);
    calculator.appendNumber(0);
    calculator.percent();

    expect(calculator.calculate()).toBe(110);
  });

  test('rejects division by zero', () => {
    expect(() => calculator.applyOperation(5, 0, '/')).toThrow('Cannot divide by zero');
  });
});
