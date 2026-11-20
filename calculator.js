(function (global) {
  class Calculator {
    constructor() {
      this.current = '0';
      this.accumulator = null;
      this.operator = null;
      this.shouldResetDisplay = false;
    }

    clear() {
      this.current = '0';
      this.accumulator = null;
      this.operator = null;
      this.shouldResetDisplay = false;
    }

    appendNumber(value) {
      if (value === undefined || value === null || value === '') {
        return this.current;
      }

      if (this.shouldResetDisplay) {
        this.current = '0';
        this.shouldResetDisplay = false;
      }

      if (this.current === '0' && value !== '.') {
        this.current = String(value);
      } else {
        this.current += String(value);
      }

      return this.current;
    }

    appendDecimal() {
      if (this.shouldResetDisplay) {
        this.current = '0';
        this.shouldResetDisplay = false;
      }

      if (!this.current.includes('.')) {
        this.current += '.';
      }

      return this.current;
    }

    toggleSign() {
      if (Number(this.current) !== 0) {
        this.current = String(-Number(this.current));
      }
      return this.current;
    }

    percent() {
      const currentValue = Number(this.current);
      const percentage = this.operator === '+' || this.operator === '-'
        ? (this.accumulator * currentValue) / 100
        : currentValue / 100;
      this.current = String(percentage);
      this.shouldResetDisplay = false;
      return this.current;
    }

    setOperator(nextOperator) {
      const value = Number(this.current);

      if (this.operator && this.accumulator !== null) {
        this.calculate();
      }

      this.accumulator = value;
      this.operator = nextOperator;
      this.shouldResetDisplay = true;
      return this.current;
    }

    calculate() {
      if (this.operator === null || this.accumulator === null) {
        return Number(this.current);
      }

      const currentValue = Number(this.current);
      const result = this.applyOperation(this.accumulator, currentValue, this.operator);

      this.current = String(result);
      this.accumulator = result;
      this.operator = null;
      this.shouldResetDisplay = true;
      return result;
    }

    applyOperation(left, right, operator) {
      switch (operator) {
        case '+':
          return this.add(left, right);
        case '-':
          return this.subtract(left, right);
        case '*':
          return this.multiply(left, right);
        case '/':
          if (right === 0) {
            throw new Error('Cannot divide by zero');
          }
          return this.divide(left, right);
        default:
          throw new Error(`Unsupported operator: ${operator}`);
      }
    }

    add(a, b) {
      return a + b;
    }

    subtract(a, b) {
      return a - b;
    }

    multiply(a, b) {
      return a * b;
    }

    divide(a, b) {
      return a / b;
    }

    getDisplay() {
      return this.current;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Calculator;
  }

  global.Calculator = Calculator;
})(typeof window !== 'undefined' ? window : globalThis);
