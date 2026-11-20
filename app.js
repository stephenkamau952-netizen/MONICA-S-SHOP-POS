const display = document.getElementById('display');
const calculator = new Calculator();

function updateDisplay() {
  display.textContent = calculator.getDisplay();
  document.querySelector('[data-action="clear"]').textContent =
    calculator.getDisplay() === '0' ? 'AC' : 'C';
  document.querySelectorAll('.operator').forEach((button) => {
    button.classList.toggle('is-selected', button.dataset.operator === calculator.operator);
  });
}

document.querySelectorAll('.number').forEach((button) => {
  button.addEventListener('click', () => {
    calculator.appendNumber(button.dataset.value);
    updateDisplay();
  });
});

document.querySelectorAll('.operator').forEach((button) => {
  button.addEventListener('click', () => {
    calculator.setOperator(button.dataset.operator);
    updateDisplay();
  });
});

document.querySelector('[data-action="decimal"]').addEventListener('click', () => {
  calculator.appendDecimal();
  updateDisplay();
});

document.querySelector('[data-action="clear"]').addEventListener('click', () => {
  calculator.clear();
  updateDisplay();
});

document.querySelector('[data-action="sign"]').addEventListener('click', () => {
  calculator.toggleSign();
  updateDisplay();
});

document.querySelector('[data-action="percent"]').addEventListener('click', () => {
  calculator.percent();
  updateDisplay();
});

document.querySelector('[data-action="equals"]').addEventListener('click', () => {
  try {
    calculator.calculate();
  } catch (error) {
    calculator.clear();
    display.textContent = 'Error';
    return;
  }
  updateDisplay();
});

updateDisplay();
