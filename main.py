import math as m
# A quadratic function solver
# returns roots

def qSolver(params):
    #l = len(params)
    a = params[0]
    b = params[1]
    c = params[2]
    disc = b**2 - 4*a*c

    if disc == 0:
        return [-b/(2*a)]
    elif disc > 0:
        return [(-b + m.sqrt(disc)) / (2*a),(-b - m.sqrt(disc)) / (2*a)]
    else:
        return []

x = 0
params = []

for _ in range(3):
    x = int(input("num of curr: "))
    params.append(x)

roots = qSolver(params)
print(roots)